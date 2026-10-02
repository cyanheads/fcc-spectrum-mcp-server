/**
 * @fileoverview Ingest schedule for the HTTP transport: the weekly rebuild on Sundays at 16:00
 * and the daily refresh at 17:00, in the process's local time (the Docker image runs in UTC).
 * Each run is a child process on this server's runtime running the compiled `ingest-job.js`,
 * so the ingest's synchronous SQLite spans never block the serving thread. The job's log lines
 * are relayed at their levels under the job's context, and a non-zero exit or a kill is logged
 * as the run's failure. Starting the schedule removes an ingest lock an earlier process with
 * this PID left behind. Stopping it stops a running job: SIGTERM, on which the job persists
 * its progress for the next run to resume, then SIGKILL after five seconds. stdio deployments
 * schedule `mirror:refresh` / `mirror:init` externally.
 * @module services/uls/ingest-schedule
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  logger,
  type RequestContext,
  requestContextService,
  schedulerService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServiceGroup } from './codes.js';
import type { IngestJobKind, IngestJobSpec, JobLogLevel, JobRecord } from './ingest-job.js';
import { clearInheritedLock, LOCK_FILE } from './schema.js';

interface ScheduledJob {
  cron: string;
  id: string;
  kind: IngestJobKind;
  label: string;
}

/** Weekly snapshots land 09:08–09:46 US Eastern on Sunday; 16:00 UTC clears them. */
const REBUILD_JOB: ScheduledJob = {
  id: 'fcc-uls-weekly-rebuild',
  cron: '0 16 * * 0',
  kind: 'rebuild',
  label: 'weekly rebuild',
};
/** Daily files land about 08:00 Eastern (Friday's at 04:00 Saturday); 17:00 UTC clears them. */
const REFRESH_JOB: ScheduledJob = {
  id: 'fcc-uls-daily-refresh',
  cron: '0 17 * * *',
  kind: 'refresh',
  label: 'daily refresh',
};

/** How long a stopped job has to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 5000;

/** The compiled job entry, beside this module in `dist/`. */
const JOB_ENTRY = fileURLToPath(new URL('./ingest-job.js', import.meta.url));

const LOG_LEVELS: ReadonlySet<string> = new Set<JobLogLevel>([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
]);

/**
 * The line a runtime prints for an uncaught error: `Error: …`, `TypeError: …`, Node's
 * `Error [ERR_MODULE_NOT_FOUND]: …`, or Bun's `error: …`. Both runtimes end a crash's stderr
 * with their version (`Node.js v26.5.0`), so a failure names this line, not the last one.
 */
const ERROR_LINE = /^(?:\w*Error|error)(?: \[\w+\])?: /;

/** Settings the schedule reads from the server config. */
export interface IngestScheduleOptions {
  baseUrl: string;
  /**
   * The process each run spawns, given the job spec as its last argument. Defaults to this
   * runtime (`process.execPath` with `process.execArgv`) running the compiled `ingest-job.js`;
   * tests point it at the built entry on a chosen runtime, or at a stand-in.
   */
  job?: { args: readonly string[]; command: string };
  mirrorDir: string;
  services: readonly ServiceGroup[];
}

interface ScheduleState {
  options: IngestScheduleOptions;
  /** Each running job process, with a promise that settles once it has exited. */
  running: Map<ChildProcess, Promise<unknown>>;
}

type FailureRecord = Extract<JobRecord, { type: 'failure' }>;

let _state: ScheduleState | undefined;

/**
 * Register and start the weekly rebuild and daily refresh jobs, first removing an ingest
 * lock an earlier process with this PID left behind ({@link clearInheritedLock}).
 */
export async function startIngestSchedule(options: IngestScheduleOptions): Promise<void> {
  const inherited = await clearInheritedLock(options.mirrorDir);
  if (inherited) {
    logger.warning(
      'Removed an ingest lock left by an earlier process with this PID.',
      requestContextService.createRequestContext({
        operation: 'startIngestSchedule',
        additionalContext: { lockPath: join(options.mirrorDir, LOCK_FILE), ...inherited },
      }),
    );
  }
  const state: ScheduleState = { options, running: new Map() };
  _state = state;
  await schedulerService.schedule(
    REBUILD_JOB.id,
    REBUILD_JOB.cron,
    (context) => runJob(state, context, REBUILD_JOB),
    'Weekly rebuild of the ULS index from the FCC weekly snapshots.',
  );
  await schedulerService.schedule(
    REFRESH_JOB.id,
    REFRESH_JOB.cron,
    (context) => runJob(state, context, REFRESH_JOB),
    'Daily refresh of the ULS index from the FCC daily incrementals.',
  );
  schedulerService.start(REBUILD_JOB.id);
  schedulerService.start(REFRESH_JOB.id);
}

/**
 * Remove the jobs and stop a run in progress: SIGTERM, then SIGKILL after
 * {@link STOP_GRACE_MS}. Resolves once the job process has exited, so the index can close
 * after it. A no-op under stdio, which never starts the schedule. A startup that failed
 * between the two registrations leaves one job, and `remove()` throws for an unknown id.
 */
export async function stopIngestSchedule(): Promise<void> {
  const state = _state;
  _state = undefined;
  if (!state) return;
  const registered = new Set(schedulerService.listJobs().map((job) => job.id));
  for (const id of [REBUILD_JOB.id, REFRESH_JOB.id]) {
    if (registered.has(id)) schedulerService.remove(id);
  }
  await Promise.all(
    [...state.running].map(async ([child, exited]) => {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      await exited;
      clearTimeout(kill);
    }),
  );
}

/**
 * Run one job process to its exit, relaying its output. The top-level boundary of a
 * background job: nothing above it would report a failure, so it logs every outcome here.
 */
async function runJob(
  state: ScheduleState,
  context: RequestContext,
  job: ScheduledJob,
): Promise<void> {
  const { baseUrl, mirrorDir, services } = state.options;
  const spec: IngestJobSpec = {
    kind: job.kind,
    baseUrl,
    mirrorDir,
    services,
    serverPid: process.pid,
  };
  const { command, args } = state.options.job ?? {
    command: process.execPath,
    args: [...process.execArgv, JOB_ENTRY],
  };
  const child = spawn(command, [...args, JSON.stringify(spec)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  state.running.set(
    child,
    exited.catch(() => {}),
  );

  let failure: FailureRecord | undefined;
  let stderrError: string | undefined;
  let lastStderr: string | undefined;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const record = parseRecord(line);
    if (record?.type === 'failure') failure = record;
    else if (record) relay(context, record.level, record.message, record.fields);
    else if (line.trim()) relay(context, 'warning', line);
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    if (!line.trim()) return;
    lastStderr = line;
    if (!stderrError && ERROR_LINE.test(line)) stderrError = line;
    relay(context, 'warning', line);
  });

  try {
    const [exitCode, signal] = await exited;
    if (exitCode === 0) return;
    const message =
      failure?.message ??
      (signal
        ? `The job process was killed by ${signal}.`
        : (stderrError ?? lastStderr ?? `The job process exited with code ${exitCode}.`));
    logger.error(
      `Scheduled ULS ${job.label} failed`,
      jobError(message, failure),
      withExtra(context, { mirrorDir, exitCode, signal }),
    );
  } catch (err) {
    // The process could not be spawned: `once` rejects on its 'error' event.
    logger.error(
      `Scheduled ULS ${job.label} failed`,
      err as Error,
      withExtra(context, { mirrorDir }),
    );
  } finally {
    state.running.delete(child);
  }
}

/** A stdout line as a job record, or `undefined` for anything else the process printed. */
function parseRecord(line: string): JobRecord | undefined {
  let record: JobRecord;
  try {
    record = JSON.parse(line) as JobRecord;
  } catch {
    return;
  }
  if (record?.type === 'failure') return record;
  if (record?.type === 'log' && LOG_LEVELS.has(record.level)) return record;
  return;
}

/** Log one relayed line at `level` under the job's context. */
function relay(
  context: RequestContext,
  level: JobLogLevel,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  logger[level](message, fields ? withExtra(context, fields) : context);
}

/** The error a failed job reported, rebuilt with its code, data, and stack when it had them. */
function jobError(message: string, failure: FailureRecord | undefined): Error {
  const error =
    failure?.code === undefined
      ? new Error(message)
      : new McpError(failure.code, message, failure.data);
  if (failure?.stack) error.stack = failure.stack;
  return error;
}
