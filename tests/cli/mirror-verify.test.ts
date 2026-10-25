/**
 * @fileoverview Tests for the compiled `mirror:verify` entry, `dist/cli/mirror-verify.js`, run
 * as a child process from a working directory outside the repo, as an installed package runs
 * it: against the fixture index it prints the JSON report (the fixture paging snapshot's
 * `counts` file overstates three record types, so the report carries three failures and the
 * process exits 1), against the microwave fixture index it passes and counts its stored paths,
 * and against an empty mirror directory it fails with the pointer to `mirror:init`. Runs on Bun
 * and, under the Node lane, on Node. The built entry is rebuilt first when any file under `src/`
 * is newer.
 * @module tests/cli/mirror-verify.test
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildFixtureIndex,
  FIXTURE_GENERATION,
  type FixtureIndex,
  makeTempDir,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(ROOT, 'dist/cli/mirror-verify.js');

/** Bun, plus Node when the suite runs on Node. */
const RUNTIMES: [string, string][] = process.versions.bun
  ? [['bun', 'bun']]
  : [
      ['bun', 'bun'],
      ['node', process.execPath],
    ];

/** The newest modification time of any file under `dir`. */
function newestMtime(dir: string): number {
  return Math.max(
    ...readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs),
  );
}

let cwd: string;

/** Run the built entry on `command` from `cwd`, against `mirrorDir`, with no FCC host reachable. */
function verify(command: string, mirrorDir: string) {
  return spawnSync(command, [ENTRY], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FCC_SPECTRUM_MIRROR_DIR: mirrorDir,
      FCC_SPECTRUM_BASE_URL: 'http://127.0.0.1:9',
    },
  });
}

beforeAll(async () => {
  if (!existsSync(ENTRY) || statSync(ENTRY).mtimeMs < newestMtime(join(ROOT, 'src'))) {
    execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  }
  cwd = await makeTempDir('cli-cwd');
}, 120_000);

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe.each(RUNTIMES)('dist/cli/mirror-verify.js on %s', (_runtime, command) => {
  let fixture: FixtureIndex;
  let micro: FixtureIndex;
  let cold: TempMirror;
  beforeAll(async () => {
    [fixture, micro, cold] = await Promise.all([
      buildFixtureIndex(),
      buildFixtureIndex({ groups: ['micro'] }),
      makeTempMirror('cli-cold'),
    ]);
  });
  afterAll(async () => {
    await fixture.dispose();
    await micro.dispose();
    await cold.remove();
  });

  it('prints the report for the fixture index and exits 1 on its count mismatches', () => {
    const run = verify(command, fixture.mirrorDir);
    expect(run.stderr).not.toMatch(/Cannot find (module|package)|Module not found/);
    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({
      generation: FIXTURE_GENERATION,
      publishedAt: '2026-09-29T20:00:00Z',
      syncState: { status: 'complete', checkpoint: '2026-09-27T13:38:53Z', total: 19 },
      integrity: 'ok',
      dailyFilesApplied: 0,
      tables: {
        licenses: 19,
        lease_links: 3,
        locations: 10,
        antennas: 10,
        frequencies: 13,
        market_blocks: 6,
        paths: 0,
      },
      failures: [
        'complete/l_paging.zip HD: read 11 of 12 lines',
        'complete/l_paging.zip EN: read 10 of 11 lines',
        'complete/l_paging.zip LO: read 9 of 10 lines',
      ],
    });
    expect(report.groups.map((group: { group: string }) => group.group)).toEqual([
      'amat',
      'mdsitfs',
      'paging',
    ]);
    expect(report.groups[2]).toMatchObject({
      group: 'paging',
      snapshotCreated: '2026-09-27T13:38:53Z',
      licensesIndexed: 8,
      lines: { HD: { upstream: 12, read: 11, rejected: 2, kept: 8 } },
    });
    expect(run.stderr).toContain('Verification failed: 3 problem(s).\n');
  });

  it('passes on the microwave fixture index and counts its stored paths', () => {
    const run = verify(command, micro.mirrorDir);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({
      generation: micro.generation,
      dailyFilesApplied: 0,
      tables: { licenses: 8, paths: 242 },
      failures: [],
    });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      group: 'micro',
      licensesIndexed: 8,
      lines: { PA: { upstream: 243, read: 243, kept: 242 } },
    });
  });

  it('fails on an empty mirror directory with the pointer to mirror:init', () => {
    const run = verify(command, cold.mirrorDir);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`No published index in ${cold.mirrorDir}; run mirror:init.\n`);
  });
});
