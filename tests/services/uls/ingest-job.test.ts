/**
 * @fileoverview Tests for the scheduled ingest job's logic, run in-process through
 * `runIngestJob()`: the skip while no generation is published, the skip on a held ingest lock,
 * the stale-checkpoint and rebuild-required fallbacks from the daily refresh to the weekly
 * rebuild, the completion lines, failures written as a failure record, the ingester's log lines
 * written as log records, the abort signal, and the server PID passed to the ingester. Ingester
 * calls that would reach the bulk host are spied; `fetch` throws if called. The job as a child
 * process is covered in `ingest-schedule.test.ts`.
 * @module tests/services/uls/ingest-job.test
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { conflict, JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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
import { UlsIngester } from '@/services/uls/ingest.js';
import { type IngestJobKind, type JobRecord, runIngestJob } from '@/services/uls/ingest-job.js';
import { LOCK_FILE, POINTER_FILE, writePointer } from '@/services/uls/schema.js';
import {
  buildFixtureIndex,
  FIXTURE_GENERATION,
  FIXTURE_GROUPS,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../../fixtures/uls-index.js';

const BASE_URL = 'https://uls.invalid/download/pub/uls';
const SERVER_PID = 4242;

/** The weekly snapshot checkpoint is 2026-09-27; this is 13 days later, past the 6-day window. */
const STALE_NOW = '2026-10-10T17:00:00Z';

let records: JobRecord[];
let fetchSpy: MockInstance;

/** Run `kind` against `mirrorDir`, collecting what it writes. */
function run(kind: IngestJobKind, mirrorDir: string, signal = new AbortController().signal) {
  return runIngestJob(
    { kind, baseUrl: BASE_URL, mirrorDir, services: FIXTURE_GROUPS, serverPid: SERVER_PID },
    (record) => records.push(record),
    signal,
  );
}

/** `[level, message]` of every log record written so far. */
const lines = () =>
  records.flatMap((record) => (record.type === 'log' ? [[record.level, record.message]] : []));

/** The fields of the first log record whose message is `message`. */
const fieldsOf = (message: string) =>
  records.find(
    (record): record is Extract<JobRecord, { type: 'log' }> =>
      record.type === 'log' && record.message === message,
  )?.fields;

/** The failure record, when one was written. */
const failure = () => records.find((record) => record.type === 'failure');

beforeEach(() => {
  records = [];
  fetchSpy = vi.fn(async () => {
    throw new Error('The ingest job tests make no network calls.');
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('no generation published', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('job-cold');
  });
  afterAll(async () => {
    await cold.remove();
  });

  it.each([
    ['rebuild', 'weekly rebuild'],
    ['refresh', 'daily refresh'],
  ] as const)('skips the %s with a notice and starts no ingest', async (kind, label) => {
    const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
    const refresh = vi.spyOn(UlsIngester.prototype, 'refresh');
    expect(await run(kind, cold.mirrorDir)).toBe(true);

    const message = `Scheduled ULS ${label} skipped: no index generation is published yet; run mirror:init once to build it.`;
    expect(lines()).toEqual([['notice', message]]);
    expect(fieldsOf(message)).toEqual({ mirrorDir: cold.mirrorDir });
    expect(rebuild).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('writes a malformed current.json as a failure and starts no ingest', async () => {
    const malformed = await makeTempMirror('job-malformed');
    try {
      await writeFile(join(malformed.mirrorDir, POINTER_FILE), '{"file": 42');
      const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
      expect(await run('rebuild', malformed.mirrorDir)).toBe(false);
      expect(failure()).toMatchObject({
        type: 'failure',
        code: JsonRpcErrorCode.SerializationError,
        message: expect.stringContaining('current.json is not a valid generation pointer'),
        data: { reason: 'malformed_pointer' },
        stack: expect.stringContaining('readPointer'),
      });
      expect(lines()).toEqual([]);
      expect(rebuild).not.toHaveBeenCalled();
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

  it.each([
    ['rebuild', 'weekly rebuild'],
    ['refresh', 'daily refresh'],
  ] as const)(
    'skips the %s with a notice when the lock is held, and leaves the lock',
    async (kind, label) => {
      const holder = JSON.stringify({
        pid: process.pid,
        mode: 'init',
        startedAt: '2026-09-29T19:00:00Z',
      });
      await writeFile(lockPath, holder);
      expect(await run(kind, fixture.mirrorDir)).toBe(true);

      const message = `Scheduled ULS ${label} skipped: another ingest holds the lock.`;
      expect(lines()).toEqual([['notice', message]]);
      expect(fieldsOf(message)).toEqual({
        message: expect.stringContaining(`Another ULS ingest (init, PID ${process.pid}`),
      });
      expect(failure()).toBeUndefined();
      expect(await readFile(lockPath, 'utf8')).toBe(holder);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('records the server PID in the lock it holds while it runs', async () => {
    let lock: unknown;
    fetchSpy.mockImplementation(async () => {
      lock = JSON.parse(await readFile(lockPath, 'utf8'));
      return new Response(null, { status: 404 });
    });
    expect(await run('rebuild', fixture.mirrorDir)).toBe(false);
    expect(lock).toEqual({
      pid: process.pid,
      mode: 'init',
      startedAt: expect.any(String),
      serverPid: SERVER_PID,
    });
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs the weekly rebuild instead when the checkpoint is past the daily window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(STALE_NOW));
    const rebuild = vi
      .spyOn(UlsIngester.prototype, 'rebuild')
      .mockResolvedValue({ status: 'skipped', generation: FIXTURE_GENERATION });
    const signal = new AbortController().signal;
    expect(await run('refresh', fixture.mirrorDir, signal)).toBe(true);

    expect(lines()).toEqual([
      [
        'notice',
        'The index checkpoint is older than the daily window; running the weekly rebuild instead.',
      ],
      ['info', 'Scheduled ULS weekly rebuild skipped'],
    ]);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild.mock.calls[0]?.[0]).toBe(signal);
    expect(fieldsOf('Scheduled ULS weekly rebuild skipped')).toEqual({
      generation: FIXTURE_GENERATION,
    });
    // The handled fallback writes nothing at error level, the sync runner included.
    expect(failure()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await fixture.service().ready()).toBe(true);
  });

  it('reclaims a lock no live process holds, writing the warning as a log record', async () => {
    await writeFile(lockPath, '{"pid":');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(STALE_NOW));
    vi.spyOn(UlsIngester.prototype, 'rebuild').mockResolvedValue({
      status: 'skipped',
      generation: FIXTURE_GENERATION,
    });
    await run('refresh', fixture.mirrorDir);

    expect(lines()[0]).toEqual([
      'warning',
      'Reclaiming an ingest lock left by a process that is gone.',
    ]);
    expect(fieldsOf('Reclaiming an ingest lock left by a process that is gone.')).toMatchObject({
      lockPath,
    });
    expect(failure()).toBeUndefined();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('logs the refresh completion with the number of files applied', async () => {
    vi.spyOn(UlsIngester.prototype, 'refresh').mockResolvedValue({
      generation: FIXTURE_GENERATION,
      applied: ['daily/l_pg_mon.zip', 'daily/l_mk_mon.zip'],
      result: {} as never,
    });
    const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
    expect(await run('refresh', fixture.mirrorDir)).toBe(true);

    expect(lines()).toEqual([['info', 'Scheduled ULS daily refresh complete']]);
    expect(fieldsOf('Scheduled ULS daily refresh complete')).toEqual({
      generation: FIXTURE_GENERATION,
      applied: 2,
    });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('fails a refresh failing any other way without falling back to the rebuild', async () => {
    const dangling = await makeTempMirror('job-dangling');
    try {
      await writePointer(dangling.mirrorDir, {
        file: 'fcc-uls-20990101T000000Z.db',
        publishedAt: '2026-09-29T20:00:00Z',
      });
      const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
      expect(await run('refresh', dangling.mirrorDir)).toBe(false);
      expect(failure()).toMatchObject({
        code: JsonRpcErrorCode.Conflict,
        message: expect.stringContaining('No published ULS index generation in'),
      });
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
    expect(await run('refresh', fixture.mirrorDir)).toBe(true);

    expect(lines()).toEqual([
      [
        'notice',
        'The published index was built by an earlier version of this server; running the weekly rebuild instead.',
      ],
      ['info', 'Scheduled ULS weekly rebuild rebuilt'],
    ]);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(failure()).toBeUndefined();
  });

  it('fails on a refresh error carrying a different reason, without falling back', async () => {
    vi.spyOn(UlsIngester.prototype, 'refresh').mockRejectedValue(
      conflict('Daily file rejected.', { reason: 'ingest_failed' }),
    );
    const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild');
    expect(await run('refresh', fixture.mirrorDir)).toBe(false);
    expect(failure()).toMatchObject({
      message: 'Daily file rejected.',
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'ingest_failed' },
    });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('logs the rebuild outcome and the published generation', async () => {
    const rebuild = vi
      .spyOn(UlsIngester.prototype, 'rebuild')
      .mockResolvedValue({ status: 'rebuilt', generation: FIXTURE_GENERATION });
    expect(await run('rebuild', fixture.mirrorDir)).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(lines()).toEqual([['info', 'Scheduled ULS weekly rebuild rebuilt']]);
    expect(fieldsOf('Scheduled ULS weekly rebuild rebuilt')).toEqual({
      generation: FIXTURE_GENERATION,
    });
  });

  it('writes a failed rebuild as a failure record', async () => {
    vi.spyOn(UlsIngester.prototype, 'rebuild').mockRejectedValue(
      serviceUnavailable('Bulk host unavailable.'),
    );
    expect(await run('rebuild', fixture.mirrorDir)).toBe(false);
    expect(failure()).toMatchObject({
      message: 'Bulk host unavailable.',
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(lines()).toEqual([]);
  });

  it('writes a thrown non-Error as a failure carrying its text', async () => {
    vi.spyOn(UlsIngester.prototype, 'rebuild').mockRejectedValue('disk full');
    expect(await run('rebuild', fixture.mirrorDir)).toBe(false);
    expect(failure()).toEqual({ type: 'failure', message: 'disk full' });
  });

  it('passes the abort signal to the ingester and fails with its reason once aborted', async () => {
    const rebuild = vi.spyOn(UlsIngester.prototype, 'rebuild').mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const outcome = run('rebuild', fixture.mirrorDir, controller.signal);
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalled());
    controller.abort(new Error('Interrupted by SIGTERM'));

    expect(await outcome).toBe(false);
    expect(failure()).toMatchObject({ message: 'Interrupted by SIGTERM' });
  });
});
