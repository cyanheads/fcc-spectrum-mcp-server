/**
 * @fileoverview One scheduled ULS ingest job — the weekly rebuild or the daily refresh — run in
 * a child process the HTTP server spawns (`ingest-schedule.ts`), so the ingest's synchronous
 * SQLite spans never block the serving thread. Run as a script, it reads an
 * {@link IngestJobSpec} from its first argument and writes one JSON {@link JobRecord} per line
 * to stdout: each log line, which the server relays at its level under the job's context, and
 * a failure record before it exits non-zero. SIGTERM or SIGINT aborts the run, which persists
 * its progress and releases the lock. An unpublished index and a held lock are skips; a daily
 * refresh whose checkpoint has aged past the daily window, or whose index needs a rebuild,
 * runs the weekly rebuild instead.
 * @module services/uls/ingest-job
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { UlsBulkClient } from './bulk-client.js';
import type { ServiceGroup } from './codes.js';
import { UlsIngester } from './ingest.js';
import { readPointer } from './schema.js';

/** Which scheduled job to run. */
export type IngestJobKind = 'rebuild' | 'refresh';

/** What the server hands a job process, as JSON in its first argument. */
export interface IngestJobSpec {
  baseUrl: string;
  kind: IngestJobKind;
  mirrorDir: string;
  /** PID of the spawning server, recorded in the ingest lock. */
  serverPid: number;
  services: readonly ServiceGroup[];
}

/** Level of a relayed log line; the framework logger has a method for each. */
export type JobLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

/** One line of a job's stdout. */
export type JobRecord =
  | {
      fields?: Readonly<Record<string, unknown>>;
      level: JobLogLevel;
      message: string;
      type: 'log';
    }
  | {
      code?: number;
      data?: Readonly<Record<string, unknown>>;
      message: string;
      stack?: string;
      type: 'failure';
    };

const LABELS: Record<IngestJobKind, string> = {
  rebuild: 'weekly rebuild',
  refresh: 'daily refresh',
};

/**
 * Run one scheduled job, writing its log lines through `write`. A skip counts as success.
 * Returns false when the job failed, after writing a failure record.
 */
export async function runIngestJob(
  spec: IngestJobSpec,
  write: (record: JobRecord) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const label = LABELS[spec.kind];
  const log = jobLogger(write);
  const client = new UlsBulkClient({ baseUrl: spec.baseUrl });
  const ingester = new UlsIngester({
    client,
    mirrorDir: spec.mirrorDir,
    services: spec.services,
    serverPid: spec.serverPid,
    logger: log,
  });
  try {
    if (!(await readPointer(spec.mirrorDir))) {
      log.notice(
        `Scheduled ULS ${label} skipped: no index generation is published yet; run mirror:init once to build it.`,
        { mirrorDir: spec.mirrorDir },
      );
      return true;
    }
    if (spec.kind === 'rebuild') await rebuild(ingester, log, signal);
    else await refresh(ingester, log, signal);
    return true;
  } catch (err) {
    if (reasonOf(err) === 'ingest_locked') {
      log.notice(`Scheduled ULS ${label} skipped: another ingest holds the lock.`, {
        message: (err as Error).message,
      });
      return true;
    }
    write(failureRecord(err));
    return false;
  } finally {
    client.dispose();
  }
}

async function rebuild(ingester: UlsIngester, log: JobLog, signal: AbortSignal): Promise<void> {
  const outcome = await ingester.rebuild(signal);
  log.info(`Scheduled ULS weekly rebuild ${outcome.status}`, { generation: outcome.generation });
}

async function refresh(ingester: UlsIngester, log: JobLog, signal: AbortSignal): Promise<void> {
  try {
    const outcome = await ingester.refresh(signal);
    log.info('Scheduled ULS daily refresh complete', {
      generation: outcome.generation,
      applied: outcome.applied.length,
    });
  } catch (err) {
    const reason = reasonOf(err);
    if (reason !== 'stale_checkpoint' && reason !== 'rebuild_required') throw err;
    log.notice(
      reason === 'stale_checkpoint'
        ? 'The index checkpoint is older than the daily window; running the weekly rebuild instead.'
        : 'The published index was built by an earlier version of this server; running the weekly rebuild instead.',
    );
    await rebuild(ingester, log, signal);
  }
}

/** The `data.reason` an ingest failure carries, when it carries one. */
function reasonOf(err: unknown): unknown {
  return err instanceof McpError ? err.data?.reason : undefined;
}

/** The failure record for `err`, keeping an `McpError`'s code and data for the server's log. */
function failureRecord(err: unknown): JobRecord {
  if (!(err instanceof Error)) return { type: 'failure', message: String(err) };
  return {
    type: 'failure',
    message: err.message,
    ...(err.stack && { stack: err.stack }),
    ...(err instanceof McpError && { code: err.code, ...(err.data && { data: err.data }) }),
  };
}

type JobLog = Required<MirrorLogger>;

/** A logger that writes each line as a log record. */
function jobLogger(write: (record: JobRecord) => void): JobLog {
  const at =
    (level: JobLogLevel) => (message: string, fields?: Readonly<Record<string, unknown>>) =>
      write({ type: 'log', level, message, ...(fields && { fields }) });
  return {
    debug: at('debug'),
    info: at('info'),
    notice: at('notice'),
    warning: at('warning'),
    error: at('error'),
  };
}

/** Script entry: run the job its argument describes and exit non-zero when it fails. */
async function main(): Promise<void> {
  const spec = JSON.parse(process.argv[2] ?? '') as IngestJobSpec;
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) => controller.abort(new Error(`Interrupted by ${signal}`));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const write = (record: JobRecord) => process.stdout.write(`${JSON.stringify(record)}\n`);
  // exitCode, not exit(): stdout to a pipe is asynchronous, and the last records must drain.
  if (!(await runIngestJob(spec, write, controller.signal))) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) await main();
