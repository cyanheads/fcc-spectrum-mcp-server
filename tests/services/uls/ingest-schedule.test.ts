/**
 * @fileoverview Tests for the HTTP ingest schedule: job registration on the real
 * `schedulerService`, each job fired through node-cron's `task.execute()`. Covers the skip
 * while no generation is published, the skip on a held ingest lock, the removal at startup of
 * a lock naming this PID, the stale-checkpoint and rebuild-required
 * fallbacks from the daily refresh to the weekly rebuild, failures logged at the job boundary,
 * the ingester's log lines routed through the framework logger, and `stopIngestSchedule()`
 * (abort, job removal, client disposal; a no-op before start; safe after a half-finished
 * start). Ingester calls that would reach the bulk host are spied; `fetch` throws if called.
 * @module tests/services/uls/ingest-schedule.test
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  conflict,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { UlsBulkClient } from '@/services/uls/bulk-client.js';
import { UlsIngester } from '@/services/uls/ingest.js';
import { startIngestSchedule, stopIngestSchedule } from '@/services/uls/ingest-schedule.js';
import { LOCK_FILE, POINTER_FILE, writePointer } from '@/services/uls/schema.js';
import {
  buildFixtureIndex,
  FIXTURE_GENERATION,
  FIXTURE_GROUPS,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../../fixtures/uls-index.js';

const REBUILD_ID = 'fcc-uls-weekly-rebuild';
const REFRESH_ID = 'fcc-uls-daily-refresh';
const BASE_URL = 'https://uls.invalid/download/pub/uls';

/** The weekly snapshot checkpoint is 2026-09-27; this is 13 days later, past the 6-day window. */
const STALE_NOW = '2026-10-10T17:00:00Z';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

let logs: Record<LogLevel, MockInstance>;
let fetchSpy: MockInstance;

/** Every message logged at `level` so far. */
const messages = (level: LogLevel): string[] =>
  logs[level].mock.calls.map((call): string => call[0]);

/** The arguments of the first `level` call whose message is `message`. */
const callFor = (level: LogLevel, message: string): unknown[] | undefined =>
  logs[level].mock.calls.find((call) => call[0] === message);

/** The fields `withExtra` attached to the first `level` line whose message is `message`. */
const extraOf = (level: LogLevel, message: string) =>
  (callFor(level, message)?.[1] as { extra?: Record<string, unknown> } | undefined)?.extra;

/** The registered job with `id`. */
function job(id: string) {
  const found = schedulerService.listJobs().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Job ${id} is not registered.`);
  return found;
}

/** Fire a job's task once, the way a cron tick would, and wait for it to finish. */
const fire = (id: string) => job(id).task.execute();

const ourJobIds = () =>
  schedulerService
    .listJobs()
    .map((candidate) => candidate.id)
    .filter((id) => id === REBUILD_ID || id === REFRESH_ID);

const start = (mirrorDir: string) =>
  startIngestSchedule({ baseUrl: BASE_URL, mirrorDir, services: FIXTURE_GROUPS });

beforeEach(() => {
  logs = {
    debug: vi.spyOn(logger, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(logger, 'info').mockImplementation(() => {}),
    notice: vi.spyOn(logger, 'notice').mockImplementation(() => {}),
    warning: vi.spyOn(logger, 'warning').mockImplementation(() => {}),
    error: vi.spyOn(logger, 'error').mockImplementation(() => {}),
  };
  fetchSpy = vi.fn(async () => {
    throw new Error('The ingest schedule tests make no network calls.');
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  stopIngestSchedule();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startIngestSchedule', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('schedule-start');
  });
  afterAll(async () => {
    await cold.remove();
  });

  it('registers and starts the weekly rebuild and the daily refresh', async () => {
    await start(cold.mirrorDir);
    expect(ourJobIds()).toEqual([REBUILD_ID, REFRESH_ID]);
    expect(job(REBUILD_ID)).toMatchObject({
      schedule: '0 16 * * 0',
      description: 'Weekly rebuild of the ULS index from the FCC weekly snapshots.',
      isRunning: false,
    });
    expect(job(REFRESH_ID)).toMatchObject({
      schedule: '0 17 * * *',
      description: 'Daily refresh of the ULS index from the FCC daily incrementals.',
      isRunning: false,
    });
    for (const id of [REBUILD_ID, REFRESH_ID]) {
      expect(job(id).task.getStatus()).not.toBe('stopped');
      expect(messages('info')).toContain(`Job '${id}' started.`);
    }
  });

  it('runs the weekly rebuild on Sundays at 16:00 and the refresh daily at 17:00', async () => {
    await start(cold.mirrorDir);
    const sunday = new Date(2026, 9, 4, 16, 0, 0);
    const monday = new Date(2026, 9, 5, 16, 0, 0);
    expect(job(REBUILD_ID).task.match(sunday)).toBe(true);
    expect(job(REBUILD_ID).task.match(monday)).toBe(false);
    expect(job(REFRESH_ID).task.match(new Date(2026, 9, 5, 17, 0, 0))).toBe(true);
    expect(job(REFRESH_ID).task.match(monday)).toBe(false);
  });
});

describe('no generation published', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('schedule-cold');
  });
  afterAll(async () => {
    await cold.remove();
  });

  it.each([
    [REBUILD_ID, 'weekly rebuild'],
    [REFRESH_ID, 'daily refresh'],
  ])('skips %s with a notice and starts no ingest', async (id, label) => {
    const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
    const refresh = vi.spyOn(UlsIngester.prototype, 'refresh');
    await start(cold.mirrorDir);
    await fire(id);

    const message = `Scheduled ULS ${label} skipped: no index generation is published yet; run mirror:init once to build it.`;
    expect(extraOf('notice', message)).toMatchObject({ mirrorDir: cold.mirrorDir, jobId: id });
    expect(rebuild).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(messages('error')).toEqual([]);
  });

  it('logs a malformed current.json as a failure and starts no ingest', async () => {
    const malformed = await makeTempMirror('schedule-malformed');
    try {
      await writeFile(join(malformed.mirrorDir, POINTER_FILE), '{"file": 42');
      const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
      await start(malformed.mirrorDir);
      await fire(REBUILD_ID);
      expect(messages('error')).toEqual(['Scheduled ULS weekly rebuild failed']);
      const [, failure, context] = callFor('error', 'Scheduled ULS weekly rebuild failed') ?? [];
      expect(failure).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      // The error is path-free for callers; the operator's log line names the directory.
      expect(context).toMatchObject({
        operation: `scheduler:job:${REBUILD_ID}`,
        extra: { mirrorDir: malformed.mirrorDir },
      });
      expect(messages('info')).toContain(`Job '${REBUILD_ID}' completed successfully.`);
      expect(rebuild).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await malformed.remove();
    }
  });
});

describe('published generation', () => {
  let fixture: FixtureIndex;
  let lockPath: string;
  beforeAll(async () => {
    fixture = await buildFixtureIndex();
    lockPath = join(fixture.mirrorDir, LOCK_FILE);
  });
  afterEach(async () => {
    await rm(lockPath, { force: true });
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  describe('a held ingest lock', () => {
    it.each([
      [REBUILD_ID, 'weekly rebuild'],
      [REFRESH_ID, 'daily refresh'],
    ])('skips %s with a notice, logs no error, and leaves the lock', async (id, label) => {
      const holder = JSON.stringify({
        pid: process.pid,
        mode: 'init',
        startedAt: '2026-09-29T19:00:00Z',
      });
      // Written after start: this process taking the lock for another job while it runs.
      await start(fixture.mirrorDir);
      await writeFile(lockPath, holder);
      await fire(id);

      const notice = extraOf(
        'notice',
        `Scheduled ULS ${label} skipped: another ingest holds the lock.`,
      );
      expect(notice).toMatchObject({
        message: expect.stringContaining(`Another ULS ingest (init, PID ${process.pid}`),
      });
      expect(messages('error')).toEqual([]);
      expect(await readFile(lockPath, 'utf8')).toBe(holder);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('removes a lock naming this PID at startup, left by an earlier process with the same PID', async () => {
      await writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, mode: 'refresh', startedAt: '2026-09-29T17:00:00Z' }),
      );
      const refresh = vi.spyOn(UlsIngester.prototype, 'refresh').mockResolvedValue({
        generation: FIXTURE_GENERATION,
        applied: [],
        result: {} as never,
      });
      await start(fixture.mirrorDir);

      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const warning = callFor(
        'warning',
        'Removed an ingest lock left by an earlier process with this PID.',
      );
      expect(warning?.[1]).toMatchObject({
        extra: { lockPath, pid: process.pid, mode: 'refresh', startedAt: '2026-09-29T17:00:00Z' },
      });
      await fire(REFRESH_ID);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(messages('notice')).not.toContain(
        'Scheduled ULS daily refresh skipped: another ingest holds the lock.',
      );
    });
  });

  describe('the daily refresh', () => {
    it('runs the weekly rebuild instead when the checkpoint is past the daily window', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(STALE_NOW));
      const rebuild = vi
        .spyOn(UlsIngester.prototype, 'rebuild')
        .mockResolvedValue({ status: 'skipped', generation: FIXTURE_GENERATION });
      await start(fixture.mirrorDir);
      await fire(REFRESH_ID);

      expect(messages('notice')).toContain(
        'The index checkpoint is older than the daily window; running the weekly rebuild instead.',
      );
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(rebuild.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
      expect(extraOf('info', 'Scheduled ULS weekly rebuild skipped')).toMatchObject({
        generation: FIXTURE_GENERATION,
      });
      // The handled fallback logs nothing at error level, the sync runner included.
      expect(messages('error')).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await fixture.service().ready()).toBe(true);
    });

    it('reclaims a lock no live process holds, logging through the framework logger', async () => {
      await writeFile(lockPath, '{"pid":');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(STALE_NOW));
      vi.spyOn(UlsIngester.prototype, 'rebuild').mockResolvedValue({
        status: 'skipped',
        generation: FIXTURE_GENERATION,
      });
      await start(fixture.mirrorDir);
      await fire(REFRESH_ID);

      const warning = callFor(
        'warning',
        'Reclaiming an ingest lock left by a process that is gone.',
      );
      expect(warning?.[1]).toMatchObject({
        operation: `scheduler:job:${REFRESH_ID}`,
        extra: { lockPath, jobId: REFRESH_ID },
      });
      expect(messages('error')).toEqual([]);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('logs completion with the number of files applied', async () => {
      vi.spyOn(UlsIngester.prototype, 'refresh').mockResolvedValue({
        generation: FIXTURE_GENERATION,
        applied: ['daily/l_pg_mon.zip', 'daily/l_mk_mon.zip'],
        result: {} as never,
      });
      const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
      await start(fixture.mirrorDir);
      await fire(REFRESH_ID);

      expect(extraOf('info', 'Scheduled ULS daily refresh complete')).toMatchObject({
        generation: FIXTURE_GENERATION,
        applied: 2,
      });
      expect(rebuild).not.toHaveBeenCalled();
      expect(messages('error')).toEqual([]);
    });

    it('logs a refresh failing any other way and does not fall back to the rebuild', async () => {
      const dangling = await makeTempMirror('schedule-dangling');
      try {
        await writePointer(dangling.mirrorDir, {
          file: 'fcc-uls-20990101T000000Z.db',
          publishedAt: '2026-09-29T20:00:00Z',
        });
        const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
        await start(dangling.mirrorDir);
        await fire(REFRESH_ID);

        const [, failure, context] = callFor('error', 'Scheduled ULS daily refresh failed') ?? [];
        expect(failure).toBeInstanceOf(McpError);
        expect((failure as McpError | undefined)?.message).toContain(
          'No published ULS index generation in',
        );
        expect(context).toMatchObject({ operation: `scheduler:job:${REFRESH_ID}` });
        expect(rebuild).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await dangling.remove();
      }
    });

    it('runs the weekly rebuild instead when the published index needs a rebuild', async () => {
      vi.spyOn(UlsIngester.prototype, 'refresh').mockRejectedValue(
        conflict('Rebuild required.', { reason: 'rebuild_required' }),
      );
      const rebuild = vi
        .spyOn(UlsIngester.prototype, 'rebuild')
        .mockResolvedValue({ status: 'rebuilt', generation: FIXTURE_GENERATION });
      await start(fixture.mirrorDir);
      await fire(REFRESH_ID);

      expect(messages('notice')).toContain(
        'The published index was built by an earlier version of this server; running the weekly rebuild instead.',
      );
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(extraOf('info', 'Scheduled ULS weekly rebuild rebuilt')).toMatchObject({
        generation: FIXTURE_GENERATION,
      });
      expect(messages('error')).toEqual([]);
    });

    it('logs a failure carrying a different reason without falling back', async () => {
      const cause = conflict('Daily file rejected.', { reason: 'ingest_failed' });
      vi.spyOn(UlsIngester.prototype, 'refresh').mockRejectedValue(cause);
      const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
      await start(fixture.mirrorDir);
      await fire(REFRESH_ID);

      expect(callFor('error', 'Scheduled ULS daily refresh failed')?.[1]).toBe(cause);
      expect(rebuild).not.toHaveBeenCalled();
    });
  });

  describe('the weekly rebuild', () => {
    it('logs the outcome and the published generation', async () => {
      const rebuild = vi
        .spyOn(UlsIngester.prototype, 'rebuild')
        .mockResolvedValue({ status: 'rebuilt', generation: FIXTURE_GENERATION });
      await start(fixture.mirrorDir);
      await fire(REBUILD_ID);

      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(extraOf('info', 'Scheduled ULS weekly rebuild rebuilt')).toMatchObject({
        generation: FIXTURE_GENERATION,
      });
      expect(messages('error')).toEqual([]);
    });

    it('logs a failed rebuild at the job boundary, so the scheduler sees success', async () => {
      const cause = serviceUnavailable('Bulk host unavailable.');
      vi.spyOn(UlsIngester.prototype, 'rebuild').mockRejectedValue(cause);
      await start(fixture.mirrorDir);
      await fire(REBUILD_ID);

      expect(callFor('error', 'Scheduled ULS weekly rebuild failed')?.[1]).toBe(cause);
      expect(messages('error')).not.toContain(`Job '${REBUILD_ID}' failed.`);
      expect(messages('info')).toContain(`Job '${REBUILD_ID}' completed successfully.`);
    });
  });

  describe('stopIngestSchedule', () => {
    it('aborts a run in progress, removes both jobs, and disposes the client', async () => {
      const dispose = vi.spyOn(UlsBulkClient.prototype, 'dispose');
      const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild').mockImplementation(
        (signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
      await start(fixture.mirrorDir);
      const run = fire(REBUILD_ID);
      await vi.waitFor(() => expect(rebuild).toHaveBeenCalled());
      const signal = rebuild.mock.calls[0]?.[0] as AbortSignal;
      expect(signal.aborted).toBe(false);

      stopIngestSchedule();
      await run;

      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error).message).toBe('Server shutting down');
      expect(callFor('error', 'Scheduled ULS weekly rebuild failed')?.[1]).toBe(signal.reason);
      expect(ourJobIds()).toEqual([]);
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('stopIngestSchedule outside a running schedule', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('schedule-stop');
  });
  afterAll(async () => {
    await cold.remove();
  });

  it('is a no-op when the schedule never started', () => {
    const remove = vi.spyOn(schedulerService, 'remove');
    const dispose = vi.spyOn(UlsBulkClient.prototype, 'dispose');
    expect(() => stopIngestSchedule()).not.toThrow();
    expect(remove).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('is a no-op the second time', async () => {
    await start(cold.mirrorDir);
    stopIngestSchedule();
    const remove = vi.spyOn(schedulerService, 'remove');
    const dispose = vi.spyOn(UlsBulkClient.prototype, 'dispose');
    stopIngestSchedule();
    expect(remove).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('cleans up after a start that failed between the two registrations', async () => {
    const schedule = schedulerService.schedule.bind(schedulerService);
    vi.spyOn(schedulerService, 'schedule')
      .mockImplementationOnce(schedule)
      .mockRejectedValueOnce(new Error('cron unavailable'));
    const remove = vi.spyOn(schedulerService, 'remove');
    const dispose = vi.spyOn(UlsBulkClient.prototype, 'dispose');

    await expect(start(cold.mirrorDir)).rejects.toThrow('cron unavailable');
    expect(ourJobIds()).toEqual([REBUILD_ID]);

    expect(() => stopIngestSchedule()).not.toThrow();
    expect(remove.mock.calls).toEqual([[REBUILD_ID]]);
    expect(ourJobIds()).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
