/**
 * @fileoverview Tests for the compiled `mirror:init` and `mirror:refresh` entries,
 * `dist/cli/mirror-init.js` and `dist/cli/mirror-refresh.js`, run as child processes from a
 * working directory outside the repo against a loopback stand-in for the ULS bulk host. Pins
 * the JSON each prints on stdout: a rebuild's generation, runner totals, and license records by
 * group; a rerun's skipped shape; a refresh's applied files, runner totals, and license records
 * by daily file. Runs on Bun and, under the Node lane, on Node. The built entries are rebuilt
 * first when any file under `src/` is newer.
 * @module tests/cli/mirror-init-refresh.test
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAILY_PG_MON, type FixtureFile, PAGING_WEEKLY } from '../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  FIXTURE_GENERATION,
  type FixtureIndex,
  makeTempDir,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INIT = join(ROOT, 'dist/cli/mirror-init.js');
const REFRESH = join(ROOT, 'dist/cli/mirror-refresh.js');

/** Bun, plus Node when the suite runs on Node. */
const RUNTIMES: [string, string][] = process.versions.bun
  ? [['bun', 'bun']]
  : [
      ['bun', 'bun'],
      ['node', process.execPath],
    ];

/** Files the stand-in host serves, by path under its `/uls/` root. */
const HOSTED: Record<string, FixtureFile> = {
  'complete/l_paging.zip': PAGING_WEEKLY,
  'daily/l_pg_mon.zip': DAILY_PG_MON,
};

/** The `daily/` listing: one link and no timestamp, so the client HEADs the file. */
const DAILY_LISTING = '<pre><a href="l_pg_mon.zip">l_pg_mon.zip</a></pre>\n';

/** The newest modification time of any file under `dir`. */
function newestMtime(dir: string): number {
  return Math.max(
    ...readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs),
  );
}

let cwd: string;
let host: Server;
let baseUrl: string;

/** Run a built entry on `command` from `cwd`, against `mirrorDir` and the stand-in host. */
function runEntry(
  command: string,
  entry: string,
  mirrorDir: string,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [entry], {
      cwd,
      env: {
        ...process.env,
        FCC_SPECTRUM_MIRROR_DIR: mirrorDir,
        FCC_SPECTRUM_BASE_URL: baseUrl,
        FCC_SPECTRUM_SERVICES: 'paging',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr, stdout }));
  });
}

beforeAll(async () => {
  if (
    [INIT, REFRESH].some(
      (entry) => !existsSync(entry) || statSync(entry).mtimeMs < newestMtime(join(ROOT, 'src')),
    )
  ) {
    execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  }
  cwd = await makeTempDir('cli-cwd');
  host = createServer((req, res) => {
    const path = req.url?.replace(/^\/uls\//, '') ?? '';
    if (req.method === 'GET' && path === 'daily/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(DAILY_LISTING);
      return;
    }
    const file = HOSTED[path];
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'last-modified': new Date(file.lastModified).toUTCString(),
      'content-length': file.zip.length,
    });
    res.end(req.method === 'HEAD' ? undefined : file.zip);
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/uls`;
}, 120_000);

afterAll(async () => {
  host.closeAllConnections();
  await new Promise((resolve) => host.close(resolve));
  await rm(cwd, { recursive: true, force: true });
});

describe.each(RUNTIMES)('dist/cli mirror:init and mirror:refresh on %s', (_runtime, command) => {
  let cold: TempMirror;
  let built: FixtureIndex;
  beforeAll(async () => {
    [cold, built] = await Promise.all([
      makeTempMirror('cli-init'),
      buildFixtureIndex({ groups: ['paging'] }),
    ]);
  });
  afterAll(async () => {
    await cold.remove();
    await built.dispose();
  });

  it('prints a rebuild’s generation, runner totals, and license records, then the skipped shape on a rerun', async () => {
    const first = await runEntry(command, INIT, cold.mirrorDir);
    expect(first.stderr).not.toMatch(/Cannot find (module|package)|Module not found/);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      status: 'rebuilt',
      generation: FIXTURE_GENERATION,
      result: { pagesFetched: 4, total: 8 },
      licenses: { paging: 8 },
    });

    const rerun = await runEntry(command, INIT, cold.mirrorDir);
    expect(rerun.status).toBe(0);
    expect(JSON.parse(rerun.stdout)).toEqual({
      status: 'skipped',
      generation: FIXTURE_GENERATION,
      licenses: {},
    });
  }, 60_000);

  it('prints a refresh’s applied files, runner totals, and license records by daily file', async () => {
    const run = await runEntry(command, REFRESH, built.mirrorDir);
    expect(run.stderr).not.toMatch(/Cannot find (module|package)|Module not found/);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      generation: built.generation,
      applied: ['daily/l_pg_mon.zip'],
      // The index's running record total: the 8 paging licenses plus the daily file's new 1100.
      result: { pagesFetched: 1, total: 9 },
      licenses: { 'daily/l_pg_mon.zip': 3 },
    });
  }, 60_000);
});
