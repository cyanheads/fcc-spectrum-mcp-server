/**
 * @fileoverview In-process ingest schedule for the HTTP transport: the weekly rebuild on
 * Sundays at 16:00 and the daily refresh at 17:00, in the process's local time (the Docker
 * image runs in UTC). Starting the schedule removes an ingest lock left by an earlier process
 * with this PID. A run that finds the ingest lock held is skipped; a daily refresh
 * whose checkpoint has aged past the daily window runs the weekly rebuild instead. The
 * initial build stays an operator step, so neither job runs before a generation is
 * published. stdio deployments schedule `mirror:refresh` / `mirror:init` externally.
 * @module services/uls/ingest-schedule
 */

import { join } from 'node:path';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import {
  logger,
  type RequestContext,
  requestContextService,
  schedulerService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import { UlsBulkClient } from './bulk-client.js';
import type { ServiceGroup } from './codes.js';
import { UlsIngester } from './ingest.js';
import { clearInheritedLock, LOCK_FILE, readPointer } from './schema.js';

/** Weekly snapshots land 09:08–09:46 US Eastern on Sunday; 16:00 UTC clears them. */
const REBUILD_JOB = { id: 'fcc-uls-weekly-rebuild', cron: '0 16 * * 0' } as const;
/** Daily files land about 08:00 Eastern (Friday's at 04:00 Saturday); 17:00 UTC clears them. */
const REFRESH_JOB = { id: 'fcc-uls-daily-refresh', cron: '0 17 * * *' } as const;

/** Settings the schedule reads from the server config. */
export interface IngestScheduleOptions {
  baseUrl: string;
  mirrorDir: string;
  services: readonly ServiceGroup[];
}

interface ScheduleState {
  client: UlsBulkClient;
  controller: AbortController;
  options: IngestScheduleOptions;
}

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
  const state: ScheduleState = {
    client: new UlsBulkClient({ baseUrl: options.baseUrl }),
    controller: new AbortController(),
    options,
  };
  _state = state;
  await schedulerService.schedule(
    REBUILD_JOB.id,
    REBUILD_JOB.cron,
    (context) => runJob(state, context, 'weekly rebuild', () => rebuild(state, context)),
    'Weekly rebuild of the ULS index from the FCC weekly snapshots.',
  );
  await schedulerService.schedule(
    REFRESH_JOB.id,
    REFRESH_JOB.cron,
    (context) => runJob(state, context, 'daily refresh', () => refresh(state, context)),
    'Daily refresh of the ULS index from the FCC daily incrementals.',
  );
  schedulerService.start(REBUILD_JOB.id);
  schedulerService.start(REFRESH_JOB.id);
}

/**
 * Stop the jobs and abort a run in progress, which persists its progress and resumes on
 * the next run. A no-op under stdio, which never starts the schedule. A startup that failed
 * between the two registrations leaves one job, and `remove()` throws for an unknown id.
 */
export function stopIngestSchedule(): void {
  const state = _state;
  _state = undefined;
  if (!state) return;
  state.controller.abort(new Error('Server shutting down'));
  const registered = new Set(schedulerService.listJobs().map((job) => job.id));
  for (const id of [REBUILD_JOB.id, REFRESH_JOB.id]) {
    if (registered.has(id)) schedulerService.remove(id);
  }
  state.client.dispose();
}

/** The `data.reason` an ingest failure carries, when it carries one. */
function reasonOf(err: unknown): unknown {
  return err instanceof McpError ? err.data?.reason : undefined;
}

/**
 * Top-level boundary of a background job: nothing above it would report a failure, so it
 * logs every outcome here. A held lock means another ingest is running and is a skip.
 */
async function runJob(
  state: ScheduleState,
  context: RequestContext,
  label: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    if (!(await readPointer(state.options.mirrorDir))) {
      logger.notice(
        `Scheduled ULS ${label} skipped: no index generation is published yet; run mirror:init once to build it.`,
        withExtra(context, { mirrorDir: state.options.mirrorDir }),
      );
      return;
    }
    await body();
  } catch (err) {
    if (reasonOf(err) === 'ingest_locked') {
      logger.notice(
        `Scheduled ULS ${label} skipped: another ingest holds the lock.`,
        withExtra(context, { message: (err as Error).message }),
      );
      return;
    }
    // Caller-facing errors leave the path out (a malformed pointer's does); this log names it.
    logger.error(
      `Scheduled ULS ${label} failed`,
      err as Error,
      withExtra(context, { mirrorDir: state.options.mirrorDir }),
    );
  }
}

async function rebuild(state: ScheduleState, context: RequestContext): Promise<void> {
  const outcome = await ingester(state, context).rebuild(state.controller.signal);
  logger.info(
    `Scheduled ULS weekly rebuild ${outcome.status}`,
    withExtra(context, { generation: outcome.generation }),
  );
}

async function refresh(state: ScheduleState, context: RequestContext): Promise<void> {
  try {
    const outcome = await ingester(state, context).refresh(state.controller.signal);
    logger.info(
      'Scheduled ULS daily refresh complete',
      withExtra(context, { generation: outcome.generation, applied: outcome.applied.length }),
    );
  } catch (err) {
    if (reasonOf(err) !== 'stale_checkpoint') throw err;
    logger.notice(
      'The index checkpoint is older than the daily window; running the weekly rebuild instead.',
      context,
    );
    await rebuild(state, context);
  }
}

function ingester(state: ScheduleState, context: RequestContext): UlsIngester {
  return new UlsIngester({
    client: state.client,
    mirrorDir: state.options.mirrorDir,
    services: state.options.services,
    logger: mirrorLogger(context),
  });
}

/** Route the sync runner's log lines through the framework logger under the job's context. */
function mirrorLogger(context: RequestContext): MirrorLogger {
  const meta = (fields?: Readonly<Record<string, unknown>>) =>
    fields ? withExtra(context, fields) : context;
  return {
    debug: (message, fields) => logger.debug(message, meta(fields)),
    info: (message, fields) => logger.info(message, meta(fields)),
    notice: (message, fields) => logger.notice(message, meta(fields)),
    warning: (message, fields) => logger.warning(message, meta(fields)),
    error: (message, fields) => logger.error(message, meta(fields)),
  };
}
