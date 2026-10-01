/**
 * @fileoverview Tests for the ULS bulk-host client over a fake `fetch`: daily listing
 * parsing, HEAD metadata, streamed downloads with their zip and length guards, retry and
 * Retry-After handling, per-file deadlines, and disposal. Timing runs on fake timers that
 * are advanced in small steps between real yields, so file I/O in flight is never raced
 * by the retry deadline.
 * @module tests/services/uls/bulk-client.test
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSleep } from 'node:timers/promises';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAILY_REQUEST_DEADLINE_MS,
  dailyZipPath,
  MAX_DOWNLOAD_BYTES,
  UlsBulkClient,
  WEEKLY_DOWNLOAD_DEADLINE_MS,
  weeklyZipPath,
} from '@/services/uls/bulk-client.js';
import { buildZip } from '../../fixtures/uls-fixtures.js';

const BASE = 'https://uls.example.test/pub/uls';
const LAST_MODIFIED = 'Sun, 27 Sep 2026 13:38:53 GMT';
const NOW = Date.parse('2026-09-29T20:00:00.400Z');
const ZIP = new Uint8Array(buildZip([{ name: 'HD.dat', data: 'HD|1|x\r\n'.repeat(50) }]));

let dir: string;
let http: FetchMockHarness;
let client: UlsBulkClient;

/** A 200 zip response as the host serves one. */
const zipResponse =
  (bytes: Uint8Array = ZIP, headers: Record<string, string> = {}) =>
  () =>
    new Response(bytes, {
      status: 200,
      headers: {
        'last-modified': LAST_MODIFIED,
        'content-length': String(bytes.length),
        ...headers,
      },
    });

/** A responder that plays `steps` in order, repeating the last one. */
function sequence(...steps: (() => Response)[]): () => Response {
  let index = 0;
  return () => {
    const step = steps[Math.min(index, steps.length - 1)] as () => Response;
    index++;
    return step();
  };
}

const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(code === 204 || code === 304 ? null : `status ${code}`, { status: code, headers });

const redirect = () => () =>
  new Response(null, { status: 302, headers: { location: 'https://uls.example.test/forbidden' } });

function makeClient(
  overrides: { fetch?: typeof globalThis.fetch; maxDownloadBytes?: number } = {},
): UlsBulkClient {
  client = new UlsBulkClient({
    baseUrl: BASE,
    fetch: overrides.fetch ?? http.fetch,
    now: () => NOW,
    version: '9.9.9',
    ...(overrides.maxDownloadBytes !== undefined && {
      maxDownloadBytes: overrides.maxDownloadBytes,
    }),
  });
  return client;
}

/**
 * Advance fake time in small steps, yielding real time between them, until `promise`
 * settles. Real yields let file writes finish before the fake clock moves far.
 */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  for (let i = 0; i < 20_000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(250);
    await realSleep(1);
  }
  return promise;
}

/** The error a driven promise rejects with. */
async function driveRejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await drive(promise);
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error('expected the promise to reject');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  dir = await mkdtemp(join(tmpdir(), 'fcc-bulk-client-'));
  http = createFetchMock();
});

afterEach(async () => {
  client?.dispose();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe('path helpers', () => {
  it('build weekly and daily paths relative to the bulk root', () => {
    expect(weeklyZipPath('paging')).toBe('complete/l_paging.zip');
    expect(weeklyZipPath('LMpriv')).toBe('complete/l_LMpriv.zip');
    expect(dailyZipPath('l_pg_mon.zip')).toBe('daily/l_pg_mon.zip');
  });
});

describe('listDailyFiles', () => {
  const listing = `
    <html><body><pre>
    <a href="../">Parent</a>
    <a href="l_pg_tue.zip">l_pg_tue.zip</a>
    <a href="l_am_mon.zip">l_am_mon.zip</a>
    <a href="l_pg_tue.zip">l_pg_tue.zip</a>
    <a href="l_gmrs_sun.zip">l_gmrs_sun.zip</a>
    <a href="a_am_mon.zip">a_am_mon.zip</a>
    <a href="l_am_mon.zip.sig">l_am_mon.zip.sig</a>
    <a href="counts.txt">counts.txt</a>
    <a href="l_notes.txt">l_notes.txt</a>
    </pre></body></html>`;

  it('keeps only license daily zips, deduped and sorted', async () => {
    http.route({ method: 'GET', match: `${BASE}/daily/`, respond: () => new Response(listing) });
    expect(await drive(makeClient().listDailyFiles())).toEqual([
      'l_am_mon.zip',
      'l_gmrs_sun.zip',
      'l_pg_tue.zip',
    ]);
  });

  it('returns an empty list for a listing with no license files', async () => {
    http.route({ match: `${BASE}/daily/`, respond: () => new Response('<html>empty</html>') });
    expect(await drive(makeClient().listDailyFiles())).toEqual([]);
  });

  it('reports a redirected listing as NotFound without retrying', async () => {
    http.route({ match: `${BASE}/daily/`, respond: redirect() });
    const error = await driveRejection(makeClient().listDailyFiles());
    expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { path: 'daily/' } });
    expect(http.calls).toHaveLength(1);
  });
});

describe('head', () => {
  it('returns Last-Modified as ISO seconds and the Content-Length', async () => {
    http.route({
      method: 'HEAD',
      match: `${BASE}/daily/l_pg_mon.zip`,
      respond: () =>
        new Response(null, {
          headers: { 'last-modified': LAST_MODIFIED, 'content-length': '12345' },
        }),
    });
    expect(await drive(makeClient().head('daily/l_pg_mon.zip'))).toEqual({
      path: 'daily/l_pg_mon.zip',
      lastModified: '2026-09-27T13:38:53Z',
      sizeBytes: 12345,
    });
  });

  it('omits sizeBytes when the host sends no usable Content-Length', async () => {
    http.route({
      match: `${BASE}/daily/a.zip`,
      respond: () => new Response(null, { headers: { 'last-modified': LAST_MODIFIED } }),
    });
    const remote = await drive(makeClient().head('daily/a.zip'));
    expect(remote).toEqual({ path: 'daily/a.zip', lastModified: '2026-09-27T13:38:53Z' });
    expect('sizeBytes' in (remote ?? {})).toBe(false);
  });

  it('returns null for a redirect, meaning the file is missing', async () => {
    http.route({ match: `${BASE}/complete/l_gone.zip`, respond: redirect() });
    expect(await drive(makeClient().head('complete/l_gone.zip'))).toBeNull();
    expect(http.calls).toHaveLength(1);
  });

  it('gives up after four attempts when Last-Modified never arrives', async () => {
    http.route({
      match: `${BASE}/daily/nolm.zip`,
      respond: () => new Response(null, { headers: { 'content-length': '10' } }),
    });
    const error = await driveRejection(makeClient().head('daily/nolm.zip'));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('no Last-Modified'),
      data: { retryAttempts: 4 },
    });
    expect(http.calls).toHaveLength(4);
  });
});

describe('request shape', () => {
  it('sends the User-Agent and refuses to follow redirects on every method', async () => {
    http.route(
      { method: 'GET', match: `${BASE}/daily/`, respond: () => new Response('') },
      {
        method: 'HEAD',
        match: `${BASE}/daily/a.zip`,
        respond: () => new Response(null, { headers: { 'last-modified': LAST_MODIFIED } }),
      },
      { method: 'GET', match: `${BASE}/daily/a.zip`, respond: zipResponse() },
    );
    const bulk = makeClient();
    await drive(bulk.listDailyFiles());
    await drive(bulk.head('daily/a.zip'));
    await drive(bulk.download('daily/a.zip', join(dir, 'a.zip')));
    expect(http.calls.map((call) => call.request.method)).toEqual(['GET', 'HEAD', 'GET']);
    for (const call of http.calls) {
      expect(call.request.headers.get('user-agent')).toBe('fcc-spectrum-mcp-server/9.9.9');
      expect(call.request.redirect).toBe('manual');
    }
  });

  it('joins paths cleanly when the base URL ends in slashes', async () => {
    http.route({ match: `${BASE}/daily/`, respond: () => new Response('') });
    client = new UlsBulkClient({ baseUrl: `${BASE}//`, fetch: http.fetch, version: '9.9.9' });
    await drive(client.listDailyFiles());
    expect(http.calls[0]?.request.url).toBe(`${BASE}/daily/`);
  });
});

describe('download', () => {
  it('writes the zip, returns its metadata, and leaves no partial file', async () => {
    http.route({ match: `${BASE}/complete/l_paging.zip`, respond: zipResponse() });
    const destination = join(dir, 'l_paging.zip');
    const download = await drive(makeClient().download('complete/l_paging.zip', destination));
    expect(download).toEqual({
      path: 'complete/l_paging.zip',
      destination,
      lastModified: '2026-09-27T13:38:53Z',
      sizeBytes: ZIP.length,
      fetchedAt: '2026-09-29T20:00:00Z',
    });
    expect((await readFile(destination)).equals(Buffer.from(ZIP))).toBe(true);
    expect(await readdir(dir)).toEqual(['l_paging.zip']);
  });

  it('accepts a body with no Content-Length', async () => {
    http.route({
      match: `${BASE}/daily/l_pg_mon.zip`,
      respond: () => new Response(ZIP, { headers: { 'last-modified': LAST_MODIFIED } }),
    });
    const download = await drive(makeClient().download('daily/l_pg_mon.zip', join(dir, 'd.zip')));
    expect(download.sizeBytes).toBe(ZIP.length);
  });

  it('retries an HTML body served as 200, then succeeds', async () => {
    http.route({
      match: `${BASE}/complete/l_paging.zip`,
      respond: sequence(
        () =>
          new Response('<html>maintenance</html>', {
            headers: { 'last-modified': LAST_MODIFIED, 'content-type': 'text/html' },
          }),
        zipResponse(),
      ),
    });
    const destination = join(dir, 'p.zip');
    await drive(makeClient().download('complete/l_paging.zip', destination));
    expect(http.calls).toHaveLength(2);
    expect(await readdir(dir)).toEqual(['p.zip']);
  });

  it('fails with ServiceUnavailable and leaves no file when the body is never a zip', async () => {
    http.route({
      match: `${BASE}/complete/l_paging.zip`,
      respond: () =>
        new Response('<html>nope</html>', { headers: { 'last-modified': LAST_MODIFIED } }),
    });
    const error = await driveRejection(
      makeClient().download('complete/l_paging.zip', join(dir, 'p.zip')),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('non-zip body'),
      data: { retryAttempts: 4 },
    });
    expect(http.calls).toHaveLength(4);
    expect(await readdir(dir)).toEqual([]);
  });

  it('treats an empty body as a non-zip and leaves no file', async () => {
    http.route({
      match: `${BASE}/daily/l_pg_mon.zip`,
      respond: () => new Response('', { headers: { 'last-modified': LAST_MODIFIED } }),
    });
    const error = await driveRejection(
      makeClient().download('daily/l_pg_mon.zip', join(dir, 'e.zip')),
    );
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a body shorter than its Content-Length, retrying, and leaves no file', async () => {
    http.route({
      match: `${BASE}/complete/l_paging.zip`,
      respond: zipResponse(ZIP, { 'content-length': String(ZIP.length + 500) }),
    });
    const error = await driveRejection(
      makeClient().download('complete/l_paging.zip', join(dir, 'p.zip')),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining(`ended at ${ZIP.length} of ${ZIP.length + 500} bytes`),
      data: { expectedBytes: ZIP.length + 500, receivedBytes: ZIP.length, retryAttempts: 4 },
    });
    expect(http.calls).toHaveLength(4);
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails with ServiceUnavailable when the download has no Last-Modified', async () => {
    http.route({ match: `${BASE}/daily/l_pg_mon.zip`, respond: () => new Response(ZIP) });
    const error = await driveRejection(
      makeClient().download('daily/l_pg_mon.zip', join(dir, 'x.zip')),
    );
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(http.calls).toHaveLength(4);
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports a redirect as NotFound without retrying', async () => {
    http.route({ match: `${BASE}/complete/l_gone.zip`, respond: redirect() });
    const error = await driveRejection(
      makeClient().download('complete/l_gone.zip', join(dir, 'g.zip')),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { path: 'complete/l_gone.zip' },
    });
    expect(http.calls).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  });

  describe('size ceiling', () => {
    it('refuses a Content-Length past the ceiling before reading the body, without retrying', async () => {
      http.route({
        match: `${BASE}/complete/l_paging.zip`,
        respond: zipResponse(ZIP, { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) }),
      });
      const error = await driveRejection(
        makeClient().download('complete/l_paging.zip', join(dir, 'p.zip')),
      );
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        message: expect.stringContaining(`more than ${MAX_DOWNLOAD_BYTES} bytes`),
        data: { path: 'complete/l_paging.zip', maxBytes: MAX_DOWNLOAD_BYTES },
      });
      expect(http.calls).toHaveLength(1);
      expect(await readdir(dir)).toEqual([]);
    });

    it('stops a body with no Content-Length once it passes the ceiling, without retrying', async () => {
      http.route({
        match: `${BASE}/daily/l_pg_mon.zip`,
        respond: () => new Response(ZIP, { headers: { 'last-modified': LAST_MODIFIED } }),
      });
      const error = await driveRejection(
        makeClient({ maxDownloadBytes: ZIP.length - 1 }).download(
          'daily/l_pg_mon.zip',
          join(dir, 'd.zip'),
        ),
      );
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        data: { path: 'daily/l_pg_mon.zip', maxBytes: ZIP.length - 1 },
      });
      expect(http.calls).toHaveLength(1);
      expect(await readdir(dir)).toEqual([]);
    });

    it('accepts a body of exactly the ceiling', async () => {
      http.route({
        match: `${BASE}/daily/l_pg_mon.zip`,
        respond: () => new Response(ZIP, { headers: { 'last-modified': LAST_MODIFIED } }),
      });
      const download = await drive(
        makeClient({ maxDownloadBytes: ZIP.length }).download(
          'daily/l_pg_mon.zip',
          join(dir, 'd.zip'),
        ),
      );
      expect(download.sizeBytes).toBe(ZIP.length);
    });
  });
});

describe('retry behavior', () => {
  it('does not retry a 404', async () => {
    http.route({ match: `${BASE}/daily/`, respond: status(404) });
    const error = await driveRejection(makeClient().listDailyFiles());
    expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { status: 404 } });
    expect(http.calls).toHaveLength(1);
  });

  it('does not retry a 403', async () => {
    http.route({ match: `${BASE}/daily/`, respond: status(403) });
    const error = await driveRejection(makeClient().listDailyFiles());
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Forbidden });
    expect(http.calls).toHaveLength(1);
  });

  it('retries a 500 and succeeds on the next attempt', async () => {
    http.route({
      match: `${BASE}/daily/`,
      respond: sequence(status(500), () => new Response('<a href="l_am_mon.zip">')),
    });
    expect(await drive(makeClient().listDailyFiles())).toEqual(['l_am_mon.zip']);
    expect(http.calls).toHaveLength(2);
  });

  it('retries a 503 and a 408', async () => {
    http.route({
      match: `${BASE}/daily/`,
      respond: sequence(status(503), status(408), () => new Response('<a href="l_am_mon.zip">')),
    });
    expect(await drive(makeClient().listDailyFiles())).toEqual(['l_am_mon.zip']);
    expect(http.calls).toHaveLength(3);
  });

  it('surfaces a persistent 500 after four attempts, with the attempt count', async () => {
    http.route({ match: `${BASE}/daily/`, respond: status(500) });
    const error = await driveRejection(makeClient().listDailyFiles());
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 500, retryAttempts: 4 },
    });
    expect(http.calls).toHaveLength(4);
  });

  it('honors a Retry-After on a 429', async () => {
    const times: number[] = [];
    http.route({
      match: `${BASE}/daily/`,
      respond: () => {
        times.push(Date.now());
        return times.length === 1
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })
          : new Response('<a href="l_am_mon.zip">');
      },
    });
    expect(await drive(makeClient().listDailyFiles())).toEqual(['l_am_mon.zip']);
    expect(times).toHaveLength(2);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(7000);
  });

  it('retries a 429 with no Retry-After after a backoff', async () => {
    http.route({
      match: `${BASE}/daily/`,
      respond: sequence(status(429), () => new Response('<a href="l_am_mon.zip">')),
    });
    expect(await drive(makeClient().listDailyFiles())).toEqual(['l_am_mon.zip']);
    expect(http.calls).toHaveLength(2);
  });

  it('fails fast on a Retry-After longer than 30 seconds', async () => {
    http.route({ match: `${BASE}/daily/`, respond: status(429, { 'retry-after': '120' }) });
    const error = await driveRejection(makeClient().listDailyFiles());
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { status: 429, retryAfter: '120' },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('waits out a Retry-After of exactly 30 seconds', async () => {
    http.route({
      match: `${BASE}/complete/l_paging.zip`,
      respond: sequence(status(429, { 'retry-after': '30' }), zipResponse()),
    });
    await drive(makeClient().download('complete/l_paging.zip', join(dir, 'p.zip')));
    expect(http.calls).toHaveLength(2);
  });

  it('retries a network failure', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response('<a href="l_am_mon.zip">');
    }) as typeof globalThis.fetch;
    expect(await drive(makeClient({ fetch: flaky }).listDailyFiles())).toEqual(['l_am_mon.zip']);
    expect(calls).toBe(2);
  });

  it('stops at once when the caller aborts', async () => {
    http.route({ match: `${BASE}/daily/`, respond: status(500) });
    const controller = new AbortController();
    const pending = makeClient().listDailyFiles(controller.signal);
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(http.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('deadlines', () => {
  /** A fetch that never answers until its signal aborts. */
  const hangingFetch = (
    () =>
    async (_url: unknown, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
  )();

  it('exports the documented budgets', () => {
    expect(DAILY_REQUEST_DEADLINE_MS).toBe(60_000);
    expect(WEEKLY_DOWNLOAD_DEADLINE_MS).toBe(20 * 60_000);
  });

  it('cuts a hanging daily download off at 60 seconds', async () => {
    const pending = makeClient({ fetch: hangingFetch }).download(
      'daily/l_pg_mon.zip',
      join(dir, 'd.zip'),
    );
    const outcome = pending.then(
      () => undefined,
      (err: Error & Record<string, unknown>) => err,
    );
    await vi.advanceTimersByTimeAsync(59_000);
    let settled = false;
    outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 60_000 },
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('applies the same 60 second budget to HEAD and the listing', async () => {
    const bulk = makeClient({ fetch: hangingFetch });
    for (const start of [() => bulk.head('daily/l_pg_mon.zip'), () => bulk.listDailyFiles()]) {
      const outcome = start().then(
        () => undefined,
        (err: Error & Record<string, unknown>) => err,
      );
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await outcome).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 60_000 },
      });
    }
  });

  it('gives a weekly download twenty minutes, not one', async () => {
    const pending = makeClient({ fetch: hangingFetch }).download(
      'complete/l_paging.zip',
      join(dir, 'p.zip'),
    );
    let settled = false;
    const outcome = pending.then(
      () => undefined,
      (err: Error & Record<string, unknown>) => {
        settled = true;
        return err;
      },
    );
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(19 * 60_000 - 2000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 20 * 60_000 },
    });
  });
});

describe('dispose', () => {
  it('rejects requests queued behind the pacer and any later request', async () => {
    const controller = new AbortController();
    const hanging = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof globalThis.fetch;
    const bulk = makeClient({ fetch: hanging });
    const first = bulk.head('daily/a.zip', controller.signal);
    first.catch(() => {});
    const queued = bulk.head('daily/b.zip');
    queued.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    bulk.dispose();
    await expect(queued).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    await expect(bulk.head('daily/c.zip')).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    controller.abort(new Error('done'));
    await expect(first).rejects.toThrow('done');
  });

  it('is safe to call twice', () => {
    const bulk = makeClient();
    bulk.dispose();
    expect(() => bulk.dispose()).not.toThrow();
  });
});

describe('request pacing', () => {
  it('starts consecutive requests at least one second apart', async () => {
    const starts: number[] = [];
    http.route({
      match: `${BASE}/daily/`,
      respond: () => {
        starts.push(Date.now());
        return new Response('');
      },
    });
    const bulk = makeClient();
    await drive(Promise.all([bulk.listDailyFiles(), bulk.listDailyFiles(), bulk.listDailyFiles()]));
    expect(starts).toHaveLength(3);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1000);
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(1000);
  });
});
