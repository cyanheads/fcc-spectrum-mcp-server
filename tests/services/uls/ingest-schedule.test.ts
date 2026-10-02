/**
 * @fileoverview Tests for the HTTP ingest schedule: job registration on the real
 * `schedulerService`, each job fired through node-cron's `task.execute()`, and each run a real
 * child process — the built `dist/services/uls/ingest-job.js` on Node or Bun against a loopback
 * bulk host, or a stand-in command. Covers the job's log lines relayed at their levels under the
 * job's context, a non-zero exit, a kill, or a failed spawn logged as the run's failure with the
 * next run unaffected, recovery from a job killed mid-run, the removal at startup of a lock an
 * earlier process with this PID left, and `stopIngestSchedule()` (SIGTERM, then SIGKILL after
 * five seconds; a no-op before start; safe after a half-finished start). The job's own logic is
 * covered in-process in `ingest-job.test.ts`. The built entry is rebuilt first when any file
 * under `src/services/uls/` is newer.
 * @module tests/services/uls/ingest-schedule.test
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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
import {
  type IngestScheduleOptions,
  startIngestSchedule,
  stopIngestSchedule,
} from '@/services/uls/ingest-schedule.js';
import { LOCK_FILE, POINTER_FILE, readPointer } from '@/services/uls/schema.js';
import { PAGING_WEEKLY } from '../../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../../fixtures/uls-index.js';

const REBUILD_ID = 'fcc-uls-weekly-rebuild';
const REFRESH_ID = 'fcc-uls-daily-refresh';
const BASE_URL = 'https://uls.invalid/download/pub/uls';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIST_ENTRY = join(ROOT, 'dist/services/uls/ingest-job.js');

/** The built job entry on Node (the runtime Vitest runs on) and on Bun. */
const RUNTIMES = {
  node: { command: process.execPath, args: [DIST_ENTRY] },
  bun: { command: 'bun', args: [DIST_ENTRY] },
} as const;

/** A stand-in job: a Node script, given the job spec as its last argument like the real one. */
const standIn = (script: string) => ({ command: process.execPath, args: ['-e', script] });

/** The paging snapshot a day newer than the published fixture one, so a rebuild builds. */
const NEWER = '2026-09-28T13:38:55Z';
const NEWER_GENERATION = 'fcc-uls-20260928T133855Z.db';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';
type LogContext = { extra?: Record<string, unknown>; operation?: string };

let logs: Record<LogLevel, MockInstance>;

/** Every message logged at `level` so far. */
const messages = (level: LogLevel): string[] =>
  logs[level].mock.calls.map((call): string => call[0]);

/** The arguments of the first `level` call whose message is `message`. */
const callFor = (level: LogLevel, message: string): unknown[] | undefined =>
  logs[level].mock.calls.find((call) => call[0] === message);

/** Every `level` call whose message is `message`. */
const callsFor = (level: LogLevel, message: string): unknown[][] =>
  logs[level].mock.calls.filter((call) => call[0] === message);

/**
 * `[level, message, context]` of every line logged under job `id`'s context, in order, less
 * the scheduler's own start and completion lines (which name the job id).
 */
function jobLines(id: string): [LogLevel, string, LogContext][] {
  return (Object.keys(logs) as LogLevel[])
    .flatMap((level) =>
      logs[level].mock.calls.map((call, i) => ({
        level,
        message: call[0] as string,
        context: call.at(-1) as LogContext,
        order: logs[level].mock.invocationCallOrder[i] ?? 0,
      })),
    )
    .filter((line) => line.context?.operation === `scheduler:job:${id}`)
    .filter((line) => !line.message.includes(`'${id}'`))
    .sort((a, b) => a.order - b.order)
    .map(({ level, message, context }) => [level, message, context]);
}

/** The registered job with `id`. */
function job(id: string) {
  const found = schedulerService.listJobs().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Job ${id} is not registered.`);
  return found;
}

/** Fire a job's task once, the way a cron tick would, and wait for its process to exit. */
const fire = (id: string) => job(id).task.execute();

const ourJobIds = () =>
  schedulerService
    .listJobs()
    .map((candidate) => candidate.id)
    .filter((id) => id === REBUILD_ID || id === REFRESH_ID);

const start = (
  mirrorDir: string,
  jobProcess: IngestScheduleOptions['job'] = RUNTIMES.node,
  baseUrl = BASE_URL,
) => startIngestSchedule({ baseUrl, mirrorDir, services: ['paging'], job: jobProcess });

/** The newest modification time of any file under `dir`. */
function newestMtime(dir: string): number {
  return Math.max(
    ...readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs),
  );
}

/** A PID that belonged to a process that has already exited. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (!pid) throw new Error('Could not spawn a short-lived process.');
  return pid;
}

/** Loopback stand-in for the ULS bulk host, serving the newer paging snapshot. */
interface FakeHost {
  baseUrl: string;
  close(): Promise<void>;
  /** Resolves on the first GET of the snapshot. */
  firstGet: Promise<void>;
  /** Hold GET responses unanswered (HEAD still answers). */
  hang: boolean;
  /** The ingest lock as it stood at each snapshot request. */
  locks: unknown[];
}

async function fakeHost(mirrorDir: string): Promise<FakeHost> {
  const held: ServerResponse[] = [];
  let gotGet: () => void = () => {};
  const firstGet = new Promise<void>((resolve) => {
    gotGet = resolve;
  });
  const server = createServer(async (req, res) => {
    if (req.url !== '/uls/complete/l_paging.zip') {
      res.writeHead(404).end();
      return;
    }
    host.locks.push(
      await readFile(join(mirrorDir, LOCK_FILE), 'utf8').then(JSON.parse, () => undefined),
    );
    if (req.method === 'GET') gotGet();
    if (req.method === 'GET' && host.hang) {
      held.push(res);
      return;
    }
    res.writeHead(200, {
      'last-modified': new Date(NEWER).toUTCString(),
      'content-length': PAGING_WEEKLY.zip.length,
    });
    res.end(req.method === 'HEAD' ? undefined : PAGING_WEEKLY.zip);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host: FakeHost = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/uls`,
    hang: false,
    locks: [],
    firstGet,
    close: async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return host;
}

beforeAll(() => {
  const srcNewest = newestMtime(join(ROOT, 'src/services/uls'));
  if (!existsSync(DIST_ENTRY) || statSync(DIST_ENTRY).mtimeMs < srcNewest) {
    execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  }
}, 120_000);

beforeEach(() => {
  logs = {
    debug: vi.spyOn(logger, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(logger, 'info').mockImplementation(() => {}),
    notice: vi.spyOn(logger, 'notice').mockImplementation(() => {}),
    warning: vi.spyOn(logger, 'warning').mockImplementation(() => {}),
    error: vi.spyOn(logger, 'error').mockImplementation(() => {}),
  };
});

afterEach(async () => {
  await stopIngestSchedule();
  vi.restoreAllMocks();
});

describe('startIngestSchedule', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('schedule-start');
  });
  afterEach(async () => {
    await rm(join(cold.mirrorDir, LOCK_FILE), { force: true });
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

  it.each([
    ['naming this PID as its holder', () => ({ pid: process.pid })],
    [
      'left by a job an earlier server with this PID spawned',
      () => ({ pid: deadPid(), serverPid: process.pid }),
    ],
  ])('removes a lock %s, taken before this process started', async (_label, holder) => {
    const lockPath = join(cold.mirrorDir, LOCK_FILE);
    const recorded = { ...holder(), mode: 'refresh', startedAt: '2026-09-29T17:00:00Z' };
    await writeFile(lockPath, JSON.stringify(recorded));
    await start(cold.mirrorDir);

    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const warning = callFor(
      'warning',
      'Removed an ingest lock left by an earlier process with this PID.',
    );
    expect(warning?.[1]).toMatchObject({ extra: { lockPath, ...recorded } });
  });
});

describe('a job run as a child process', () => {
  let fixture: FixtureIndex;
  let host: FakeHost;
  beforeEach(async () => {
    fixture = await buildFixtureIndex({ groups: ['paging'] });
    host = await fakeHost(fixture.mirrorDir);
  });
  afterEach(async () => {
    await host.close();
    await fixture.dispose();
  });

  it.each(Object.keys(RUNTIMES) as (keyof typeof RUNTIMES)[])(
    'relays a weekly rebuild’s lines at their levels under the job context, on %s',
    async (runtime) => {
      await start(fixture.mirrorDir, RUNTIMES[runtime], host.baseUrl);
      await fire(REBUILD_ID);

      const lines = jobLines(REBUILD_ID);
      expect(lines.map(([level, message]) => [level, message])).toEqual([
        ['info', 'Building index generation'],
        ['info', 'Downloaded weekly snapshot'],
        ['info', 'Loaded license records'],
        ['info', 'Loaded technical records'],
        ['info', 'Mirror sync complete'],
        ['info', 'Published index generation'],
        ['info', 'Scheduled ULS weekly rebuild rebuilt'],
      ]);
      for (const [, , context] of lines) expect(context.extra).toMatchObject({ jobId: REBUILD_ID });
      expect(lines[0]?.[2].extra).toMatchObject({ generation: NEWER_GENERATION, groups: 'paging' });
      expect(lines[5]?.[2].extra).toMatchObject({ generation: NEWER_GENERATION });
      expect(lines[6]?.[2].extra).toMatchObject({ generation: NEWER_GENERATION });
      expect(messages('error')).toEqual([]);
      expect(await readPointer(fixture.mirrorDir)).toMatchObject({ file: NEWER_GENERATION });

      // The job held the lock under its own PID, naming this process as its server.
      expect(host.locks[0]).toEqual({
        pid: expect.any(Number),
        mode: 'init',
        startedAt: expect.any(String),
        serverPid: process.pid,
      });
      expect((host.locks[0] as { pid: number }).pid).not.toBe(process.pid);
      expect(existsSync(join(fixture.mirrorDir, LOCK_FILE))).toBe(false);
    },
    30_000,
  );

  it('relays the skip while no generation is published, at notice level', async () => {
    const cold = await makeTempMirror('schedule-cold');
    try {
      await start(cold.mirrorDir);
      await fire(REFRESH_ID);
      const message =
        'Scheduled ULS daily refresh skipped: no index generation is published yet; run mirror:init once to build it.';
      expect(jobLines(REFRESH_ID).map(([level, line]) => [level, line])).toEqual([
        ['notice', message],
      ]);
      expect(callFor('notice', message)?.[1]).toMatchObject({
        operation: `scheduler:job:${REFRESH_ID}`,
        extra: { mirrorDir: cold.mirrorDir, jobId: REFRESH_ID },
      });
      expect(messages('error')).toEqual([]);
    } finally {
      await cold.remove();
    }
  });

  it('relays the skip on a held lock, and leaves the lock', async () => {
    const lockPath = join(fixture.mirrorDir, LOCK_FILE);
    const holder = JSON.stringify({
      pid: process.pid,
      mode: 'init',
      startedAt: '2026-09-29T19:00:00Z',
    });
    await start(fixture.mirrorDir, RUNTIMES.node, host.baseUrl);
    await writeFile(lockPath, holder);
    await fire(REBUILD_ID);

    const message = 'Scheduled ULS weekly rebuild skipped: another ingest holds the lock.';
    expect(callFor('notice', message)?.[1]).toMatchObject({
      extra: { message: expect.stringContaining(`Another ULS ingest (init, PID ${process.pid}`) },
    });
    expect(messages('error')).toEqual([]);
    expect(await readFile(lockPath, 'utf8')).toBe(holder);
    expect(host.locks).toEqual([]);
  });

  it('logs a failed job with its exit code and error, and the next tick runs a new job', async () => {
    await writeFile(join(fixture.mirrorDir, POINTER_FILE), '{"file": 42');
    await start(fixture.mirrorDir);
    await fire(REBUILD_ID);

    const failures = callsFor('error', 'Scheduled ULS weekly rebuild failed');
    expect(failures).toHaveLength(1);
    const [, failure, context] = failures[0] ?? [];
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'current.json is not a valid generation pointer; rerun mirror:init to republish it.',
      data: { reason: 'malformed_pointer' },
      stack: expect.stringContaining('readPointer'),
    });
    expect(context).toMatchObject({
      operation: `scheduler:job:${REBUILD_ID}`,
      extra: { mirrorDir: fixture.mirrorDir, exitCode: 1, signal: null },
    });
    // The failure is the run's outcome, logged here; the scheduler sees the job complete.
    expect(messages('info')).toContain(`Job '${REBUILD_ID}' completed successfully.`);

    await fire(REBUILD_ID);
    expect(callsFor('error', 'Scheduled ULS weekly rebuild failed')).toHaveLength(2);
  });

  it('logs a killed job with its signal, and the next tick runs a new job', async () => {
    // A line on stderr first: the failure still names the signal, not that line.
    await start(
      fixture.mirrorDir,
      standIn("process.stderr.write('working\\n', () => process.kill(process.pid, 'SIGKILL'))"),
    );
    await fire(REFRESH_ID);

    expect(messages('warning')).toContain('working');
    const [, failure, context] = callFor('error', 'Scheduled ULS daily refresh failed') ?? [];
    expect((failure as Error).message).toBe('The job process was killed by SIGKILL.');
    expect(context).toMatchObject({ extra: { exitCode: null, signal: 'SIGKILL' } });

    await fire(REFRESH_ID);
    expect(callsFor('error', 'Scheduled ULS daily refresh failed')).toHaveLength(2);
  });

  it('relays output outside the record protocol as warnings, failing with the last stderr line', async () => {
    await start(
      fixture.mirrorDir,
      standIn(
        "console.log('not a record'); console.error('first'); console.error('boom'); process.exit(3)",
      ),
    );
    await fire(REFRESH_ID);

    expect(messages('warning')).toEqual(expect.arrayContaining(['not a record', 'first', 'boom']));
    const [, failure, context] = callFor('error', 'Scheduled ULS daily refresh failed') ?? [];
    expect((failure as Error).message).toBe('boom');
    expect(context).toMatchObject({ extra: { exitCode: 3, signal: null } });
  });

  it('fails a crashed job with its uncaught error, not the runtime version line', async () => {
    await start(fixture.mirrorDir, standIn("throw new TypeError('boom')"));
    await fire(REFRESH_ID);

    const [, failure, context] = callFor('error', 'Scheduled ULS daily refresh failed') ?? [];
    expect((failure as Error).message).toBe('TypeError: boom');
    expect(context).toMatchObject({ extra: { exitCode: 1, signal: null } });
  });

  it('logs a job process that could not be spawned', async () => {
    await start(fixture.mirrorDir, { command: join(ROOT, 'no-such-runtime'), args: [] });
    await fire(REFRESH_ID);
    const [, failure] = callFor('error', 'Scheduled ULS daily refresh failed') ?? [];
    expect(failure).toMatchObject({ code: 'ENOENT' });
    expect(messages('info')).toContain(`Job '${REFRESH_ID}' completed successfully.`);
  });

  it('recovers from a job killed mid-run: the next run reclaims its lock and builds', async () => {
    host.hang = true;
    await start(fixture.mirrorDir, RUNTIMES.node, host.baseUrl);
    const run = fire(REBUILD_ID);
    await host.firstGet;
    const lockPath = join(fixture.mirrorDir, LOCK_FILE);
    const holder = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    process.kill(holder.pid, 'SIGKILL');
    await run;

    expect(callFor('error', 'Scheduled ULS weekly rebuild failed')?.[2]).toMatchObject({
      extra: { signal: 'SIGKILL' },
    });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
      pid: holder.pid,
      serverPid: process.pid,
    });
    expect((await readPointer(fixture.mirrorDir))?.file).toBe(fixture.generation);

    host.hang = false;
    await fire(REBUILD_ID);
    expect(messages('warning')).toContain(
      'Reclaiming an ingest lock left by a process that is gone.',
    );
    expect(messages('info')).toContain('Scheduled ULS weekly rebuild rebuilt');
    expect(await readPointer(fixture.mirrorDir)).toMatchObject({ file: NEWER_GENERATION });
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);
});

describe('stopIngestSchedule', () => {
  let fixture: FixtureIndex;
  let host: FakeHost;
  beforeEach(async () => {
    fixture = await buildFixtureIndex({ groups: ['paging'] });
    host = await fakeHost(fixture.mirrorDir);
  });
  afterEach(async () => {
    await host.close();
    await fixture.dispose();
  });

  it('stops a running job with SIGTERM: it releases the lock and leaves the published generation', async () => {
    host.hang = true;
    await start(fixture.mirrorDir, RUNTIMES.node, host.baseUrl);
    const run = fire(REBUILD_ID);
    await host.firstGet;

    const stopping = performance.now();
    await stopIngestSchedule();
    const elapsed = performance.now() - stopping;
    await run;

    expect(elapsed).toBeLessThan(5000);
    expect(ourJobIds()).toEqual([]);
    const [, failure, context] = callFor('error', 'Scheduled ULS weekly rebuild failed') ?? [];
    expect((failure as Error).message).toBe('Interrupted by SIGTERM');
    expect(context).toMatchObject({ extra: { exitCode: 1, signal: null } });
    expect(existsSync(join(fixture.mirrorDir, LOCK_FILE))).toBe(false);
    expect((await readPointer(fixture.mirrorDir))?.file).toBe(fixture.generation);
    expect(await fixture.service().ready()).toBe(true);
  }, 30_000);

  it('kills a job that has not exited five seconds after SIGTERM', async () => {
    const ignoresSigterm = standIn(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log(JSON.stringify({ type: 'log', level: 'info', message: 'started' }));",
    );
    await start(fixture.mirrorDir, ignoresSigterm);
    const run = fire(REFRESH_ID);
    await vi.waitFor(() => expect(messages('info')).toContain('started'), { timeout: 10_000 });

    const stopping = performance.now();
    await stopIngestSchedule();
    const elapsed = performance.now() - stopping;
    await run;

    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(6500);
    expect(callFor('error', 'Scheduled ULS daily refresh failed')?.[2]).toMatchObject({
      extra: { exitCode: null, signal: 'SIGKILL' },
    });
  }, 20_000);

  it('is a no-op when the schedule never started', async () => {
    const remove = vi.spyOn(schedulerService, 'remove');
    await expect(stopIngestSchedule()).resolves.toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
  });

  it('is a no-op the second time', async () => {
    await start(fixture.mirrorDir);
    await stopIngestSchedule();
    const remove = vi.spyOn(schedulerService, 'remove');
    await stopIngestSchedule();
    expect(remove).not.toHaveBeenCalled();
  });

  it('cleans up after a start that failed between the two registrations', async () => {
    const schedule = schedulerService.schedule.bind(schedulerService);
    vi.spyOn(schedulerService, 'schedule')
      .mockImplementationOnce(schedule)
      .mockRejectedValueOnce(new Error('cron unavailable'));
    const remove = vi.spyOn(schedulerService, 'remove');

    await expect(start(fixture.mirrorDir)).rejects.toThrow('cron unavailable');
    expect(ourJobIds()).toEqual([REBUILD_ID]);

    await expect(stopIngestSchedule()).resolves.toBeUndefined();
    expect(remove.mock.calls).toEqual([[REBUILD_ID]]);
    expect(ourJobIds()).toEqual([]);
  });
});
