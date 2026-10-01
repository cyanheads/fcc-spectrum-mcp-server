/**
 * @fileoverview Tests for `UlsIngester`: the weekly rebuild's content (counts, derived flags,
 * derived site states, the live-status rule, emissions joined on `freq_seq_id`, market
 * blocks, summaries, per-type line statistics, and what is never ingested), the resume rule,
 * rebuild triggers and generation naming (a retired generation is never reused), the ingest
 * lock, the daily replace-by-USI refresh (band bounds widened per file), and `marketStates`. Every upstream byte comes from the fixture zips through the fake client.
 * @module tests/services/uls/ingest.test
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { marketStates, type RebuildResult } from '@/services/uls/ingest.js';
import {
  createUlsStore,
  LICENSE_COLUMNS,
  LOCK_FILE,
  POINTER_FILE,
  readPointer,
  writePointer,
} from '@/services/uls/schema.js';
import { UlsIndexService } from '@/services/uls/uls-index-service.js';
import { openZipArchive } from '@/services/uls/zip-reader.js';
import {
  AMAT_WEEKLY,
  at,
  buildZip,
  countsFile,
  DAILY_MK_MON,
  DAILY_PG_MON,
  DAILY_PG_SUN,
  DAILY_PG_TUE,
  DAILY_WIDE_MON,
  datFile,
  FakeIngestClient,
  hd,
  lo,
  MDSITFS_WEEKLY,
  PAGING_WEEKLY,
} from '../../fixtures/uls-fixtures.js';
import {
  FIXTURE_GENERATION,
  FIXTURE_GROUPS,
  type FixtureGroup,
  fixtureIngester,
  makeTempMirror,
  type TempMirror,
} from '../../fixtures/uls-index.js';

/** Run `read` against a generation file through its own short-lived connection. */
async function readDb<T>(path: string, read: (db: SqliteHandle) => T): Promise<T> {
  const store = createUlsStore(path);
  try {
    return read(await store.raw());
  } finally {
    await store.close();
  }
}

const all = <T>(db: SqliteHandle, sql: string, ...args: (string | number)[]) =>
  db.prepare<T>(sql).all(...args);

const count = (db: SqliteHandle, sql: string, ...args: (string | number)[]) =>
  db.prepare<{ n: number }>(sql).get(...args)?.n;

/** The `ingest_files` stats of one applied file, parsed. */
function stats(db: SqliteHandle, path: string): Record<string, Record<string, number>> {
  const row = db
    .prepare<{ stats_json: string }>('SELECT stats_json FROM ingest_files WHERE path = ?')
    .get(path);
  return JSON.parse(row?.stats_json ?? 'null') as Record<string, Record<string, number>>;
}

/** A PID that belonged to a process that has already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  if (!pid) throw new Error('Could not spawn a short-lived process.');
  return pid;
}

/** Same zip, newer `Last-Modified` (and `counts` time) — next week's snapshot. */
const nextWeek = (file: typeof PAGING_WEEKLY, lastModified: string) => ({ ...file, lastModified });

const mirrors: TempMirror[] = [];
async function tempMirror(): Promise<TempMirror> {
  const mirror = await makeTempMirror('ingest');
  mirrors.push(mirror);
  return mirror;
}

afterAll(async () => {
  await Promise.all(mirrors.map((mirror) => mirror.remove()));
});

describe('rebuild content (all three groups)', () => {
  let mirror: TempMirror;
  let client: FakeIngestClient;
  let result: RebuildResult;
  let dbPath: string;

  beforeAll(async () => {
    mirror = await tempMirror();
    client = new FakeIngestClient().withWeekly(FIXTURE_GROUPS);
    result = await fixtureIngester(mirror, { client }).rebuild();
    dbPath = join(mirror.mirrorDir, result.generation);
  });

  it('publishes a generation named from the earliest snapshot Last-Modified', async () => {
    expect(result).toMatchObject({ status: 'rebuilt', generation: FIXTURE_GENERATION });
    expect(result.result?.total).toBe(19);
    expect(await readPointer(mirror.mirrorDir)).toEqual({
      file: FIXTURE_GENERATION,
      publishedAt: '2026-09-29T20:00:00Z',
    });
  });

  it('downloads each snapshot once and records the earliest counts time as the checkpoint', async () => {
    for (const group of FIXTURE_GROUPS) {
      expect(client.downloads(`complete/l_${group}.zip`)).toBe(1);
    }
    const store = createUlsStore(dbPath);
    try {
      const state = await store.readState();
      expect(state.status).toBe('complete');
      expect(state.checkpoint).toBe('2026-09-27T13:38:53Z');
      expect(state.completedAt).toBeDefined();
      expect(state.cursor).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('loads every record set once, with the first duplicate HD winning', async () => {
    await readDb(dbPath, (db) => {
      expect(
        all<{ service_group: string; n: number }>(
          db,
          'SELECT service_group, count(*) AS n FROM licenses GROUP BY service_group ORDER BY service_group',
        ),
      ).toEqual([
        { service_group: 'amat', n: 3 },
        { service_group: 'mdsitfs', n: 8 },
        { service_group: 'paging', n: 8 },
      ]);
      expect(
        all<{ usi: number }>(db, 'SELECT usi FROM licenses ORDER BY usi').map((r) => r.usi),
      ).toEqual([
        1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 2001, 2002, 2003, 2004, 2005, 2006, 2007,
        2008, 3001, 3002, 3003,
      ]);
      expect(
        db
          .prepare<{ callsign: string; license_status: string }>(
            'SELECT callsign, license_status FROM licenses WHERE usi = 1001',
          )
          .get(),
      ).toEqual({ callsign: 'KZZ901', license_status: 'A' });
      expect(count(db, 'SELECT count(*) AS n FROM lease_links')).toBe(3);
      expect(count(db, 'SELECT count(*) AS n FROM locations')).toBe(10);
      expect(count(db, 'SELECT count(*) AS n FROM antennas')).toBe(10);
      expect(count(db, 'SELECT count(*) AS n FROM frequencies')).toBe(13);
      expect(count(db, 'SELECT count(*) AS n FROM market_blocks')).toBe(6);
    });
  });

  it('flags leases, individuals (type I, and a blank type under HA), and market states', async () => {
    await readDb(dbPath, (db) => {
      const usis = (sql: string) => all<{ usi: number }>(db, sql).map((row) => row.usi);
      expect(usis('SELECT usi FROM licenses WHERE is_lease = 1 ORDER BY usi')).toEqual([
        2002, 2004, 2006,
      ]);
      expect(usis('SELECT usi FROM licenses WHERE is_individual = 1 ORDER BY usi')).toEqual([
        1003, 3001, 3003,
      ]);
      expect(
        all<{ usi: number; market_states: string | null }>(
          db,
          'SELECT usi, market_states FROM licenses WHERE market_code IS NOT NULL ORDER BY usi',
        ),
      ).toEqual([
        { usi: 2001, market_states: ',ND,MN,' },
        { usi: 2002, market_states: ',ND,MN,' },
        { usi: 2003, market_states: null },
        { usi: 2004, market_states: ',ND,MN,' },
        { usi: 2005, market_states: ',CA,' },
        { usi: 2006, market_states: ',ND,SD,' },
      ]);
    });
  });

  it('keeps the CR inside a licensee name and leaves a blank callsign null', async () => {
    await readDb(dbPath, (db) => {
      const name = (usi: number) =>
        db
          .prepare<{ licensee_name: string | null; callsign: string | null }>(
            'SELECT licensee_name, callsign FROM licenses WHERE usi = ?',
          )
          .get(usi);
      expect(name(1007)?.licensee_name).toBe('Carriage\rReturn Paging');
      expect(name(2007)?.callsign).toBeNull();
    });
  });

  it('derives a blank site state from the coordinates and flags it; a filed state wins', async () => {
    await readDb(dbPath, (db) => {
      expect(
        all(
          db,
          'SELECT usi, location_number AS loc, state, site_state, state_derived FROM locations ORDER BY usi, location_number',
        ),
      ).toEqual([
        { usi: 1001, loc: 1, state: 'WA', site_state: 'WA', state_derived: 0 },
        { usi: 1001, loc: 2, state: null, site_state: 'WA', state_derived: 1 },
        { usi: 1003, loc: 1, state: 'wa', site_state: 'WA', state_derived: 0 },
        { usi: 1006, loc: 1, state: 'OR', site_state: 'OR', state_derived: 0 },
        { usi: 1007, loc: 1, state: 'ID', site_state: 'ID', state_derived: 0 },
        { usi: 1008, loc: 1, state: null, site_state: 'WA', state_derived: 1 },
        { usi: 1009, loc: 1, state: null, site_state: null, state_derived: 0 },
        { usi: 2001, loc: 1, state: null, site_state: 'ND', state_derived: 1 },
        { usi: 2001, loc: 2, state: 'MN', site_state: 'MN', state_derived: 0 },
        { usi: 2005, loc: 1, state: 'CA', site_state: 'CA', state_derived: 0 },
      ]);
    });
  });

  it('keeps invalid coordinates as DMS text only, and antimeridian coordinates as decimals', async () => {
    await readDb(dbPath, (db) => {
      const site = (usi: number) =>
        db
          .prepare<{ lat: number | null; lon: number | null; coord_dms: string | null }>(
            'SELECT lat, lon, coord_dms FROM locations WHERE usi = ?',
          )
          .get(usi);
      const invalid = site(1007);
      expect(invalid?.lat).toBeNull();
      expect(invalid?.lon).toBeNull();
      expect(invalid?.coord_dms).toMatch(/61/);
      const aleutian = site(1009);
      expect(aleutian?.lat).toBeCloseTo(52, 6);
      expect(aleutian?.lon).toBeCloseTo(-179.8, 6);
    });
  });

  it('keeps no technical rows for non-live records', async () => {
    await readDb(dbPath, (db) => {
      for (const table of ['locations', 'antennas', 'frequencies', 'market_blocks']) {
        expect(
          count(
            db,
            `SELECT count(*) AS n FROM ${table} t JOIN licenses l ON l.usi = t.usi
             WHERE l.license_status NOT IN ('A', 'L', 'X')`,
          ),
          table,
        ).toBe(0);
      }
      // 1002 (C) and 2003 (E) filed LO/FR/MF lines in the snapshots; none survive.
      expect(count(db, 'SELECT count(*) AS n FROM frequencies WHERE usi = 1002')).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM market_blocks WHERE usi = 2003')).toBe(0);
    });
  });

  it('joins emissions on freq_seq_id and derives bandwidth and the occupied band', async () => {
    await readDb(dbPath, (db) => {
      const rows = all<{
        loc: number;
        seq: number;
        frequency_mhz: number | null;
        emissions: string | null;
        bandwidth_mhz: number | null;
        occ_low: number | null;
        occ_high: number | null;
      }>(
        db,
        `SELECT location_number AS loc, freq_seq_id AS seq, frequency_mhz, emissions, bandwidth_mhz,
           occ_low, occ_high FROM frequencies WHERE usi = ? ORDER BY location_number, freq_seq_id`,
        1001,
      );
      expect(rows.map((row) => [row.loc, row.seq])).toEqual([
        [1, 1],
        [1, 2],
        [1, 3],
        [2, 1],
      ]);
      const [seq1, seq2, seq3, far] = rows;
      // Adaptive modulation: two rows at 152.24, each with its own emissions.
      expect(seq1?.emissions?.split(',').sort()).toEqual(['11K2F3E', '16K0F3E']);
      expect(seq1?.bandwidth_mhz).toBeCloseTo(0.016, 9);
      expect(seq1?.occ_low).toBeCloseTo(152.232, 9);
      expect(seq1?.occ_high).toBeCloseTo(152.248, 9);
      expect(seq2?.emissions).toBe('11K2F3E');
      expect(seq2?.bandwidth_mhz).toBeCloseTo(0.0112, 9);
      expect(seq2?.occ_low).toBeCloseTo(152.2344, 9);
      expect(seq3).toMatchObject({ emissions: null, bandwidth_mhz: null });
      expect(seq3?.occ_low).toBe(454.1);
      expect(seq3?.occ_high).toBe(454.1);
      expect(far?.emissions).toBe('20K0F1D');
      expect(far?.occ_high).toBeCloseTo(931.0225, 9);

      const brs = db
        .prepare<{ occ_low: number; occ_high: number; bandwidth_mhz: number }>(
          'SELECT occ_low, occ_high, bandwidth_mhz FROM frequencies WHERE usi = 2001 AND location_number = 1',
        )
        .get();
      expect(brs).toEqual({ occ_low: 2497, occ_high: 2509, bandwidth_mhz: 6 });

      const aleutian = all<{ frequency_mhz: number | null; emissions: string | null }>(
        db,
        'SELECT frequency_mhz, emissions, occ_low FROM frequencies WHERE usi = 1009 ORDER BY freq_seq_id',
      );
      expect(aleutian).toEqual([
        { frequency_mhz: 929.5, emissions: 'XYZ', occ_low: 929.5 },
        { frequency_mhz: null, emissions: null, occ_low: null },
      ]);
      // The lowercase designator is kept as filed; its bandwidth parses uppercased.
      expect(
        db
          .prepare<{ emissions: string; bandwidth_mhz: number }>(
            'SELECT emissions, bandwidth_mhz FROM frequencies WHERE usi = 1006',
          )
          .get(),
      ).toEqual({ emissions: '11k2f3e', bandwidth_mhz: expect.closeTo(0.0112, 9) });
    });
  });

  it('keys a blank MF partition area as 0', async () => {
    await readDb(dbPath, (db) => {
      expect(
        all(
          db,
          'SELECT partition_area_id, lower, upper FROM market_blocks WHERE usi = 2001 ORDER BY lower',
        ),
      ).toEqual([
        { partition_area_id: 1, lower: 2496, upper: 2502 },
        { partition_area_id: 0, lower: 2502, upper: 2508 },
      ]);
    });
  });

  it('stores the widest bands and per-group stats in meta, and counts per service code', async () => {
    await readDb(dbPath, (db) => {
      const meta = new Map(
        all<{ key: string; value: string }>(db, 'SELECT key, value FROM meta').map((row) => [
          row.key,
          row.value,
        ]),
      );
      expect(Number(meta.get('max_site_band_mhz'))).toBe(12);
      expect(Number(meta.get('max_market_band_mhz'))).toBe(6);
      expect(JSON.parse(meta.get('group_stats') ?? '{}')).toEqual({
        paging: { records: 8, sites: 7, frequencies: 10 },
        mdsitfs: { records: 8, sites: 3, frequencies: 3 },
        amat: { records: 3, sites: 0, frequencies: 0 },
      });
      expect(
        all(db, 'SELECT code, service_group, record_count FROM service_codes ORDER BY code'),
      ).toEqual([
        { code: 'BR', service_group: 'mdsitfs', record_count: 6 },
        { code: 'CD', service_group: 'paging', record_count: 7 },
        { code: 'ED', service_group: 'mdsitfs', record_count: 2 },
        { code: 'HA', service_group: 'amat', record_count: 3 },
        { code: 'ZQ', service_group: 'paging', record_count: 1 },
      ]);
    });
  });

  it('never stores EN contact fields or non-licensee entities', async () => {
    await readDb(dbPath, (db) => {
      const columns = all<{ name: string }>(db, 'PRAGMA table_info(licenses)').map((c) => c.name);
      expect(columns.sort()).toEqual(Object.keys(LICENSE_COLUMNS).sort());
      const tables = all<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'licenses_fts%'",
      ).map((row) => row.name);
      const dump = JSON.stringify(tables.map((table) => all(db, `SELECT * FROM "${table}"`)));
      for (const secret of [
        '100 Private Way',
        '98101',
        '2065550100',
        'private@example.test',
        'Contact Person Example',
        'NOWHERE',
      ]) {
        expect(dump).not.toContain(secret);
      }
    });
  });

  it('records read, kept, rejected, and orphaned line counts per record type', async () => {
    await readDb(dbPath, (db) => {
      expect(stats(db, 'complete/l_paging.zip')).toEqual({
        HD: { read: 11, rejected: 2, kept: 8 },
        EN: { read: 10, rejected: 1, kept: 8 },
        LO: { read: 9, rejected: 1, kept: 7 },
        AN: { read: 8, rejected: 0, kept: 7 },
        FR: { read: 11, rejected: 0, kept: 10 },
        EM: { read: 9, rejected: 0, kept: 8, orphaned: 1 },
      });
      expect(stats(db, 'complete/l_mdsitfs.zip')).toEqual({
        HD: { read: 8, rejected: 0, kept: 8 },
        EN: { read: 8, rejected: 0, kept: 8 },
        MK: { read: 6, rejected: 0, kept: 6 },
        LL: { read: 3, rejected: 0, kept: 3 },
        LO: { read: 3, rejected: 0, kept: 3 },
        AN: { read: 3, rejected: 0, kept: 3 },
        FR: { read: 3, rejected: 0, kept: 3 },
        EM: { read: 3, rejected: 0, kept: 3, orphaned: 0 },
        MF: { read: 7, rejected: 0, kept: 6 },
      });
      expect(stats(db, 'complete/l_amat.zip')).toEqual({
        HD: { read: 3, rejected: 0, kept: 3 },
        EN: { read: 3, rejected: 0, kept: 3 },
        AM: { read: 3, rejected: 0, kept: 3 },
      });
    });
  });

  it('records each snapshot in ingest_files as complete, with its counts and Last-Modified', async () => {
    await readDb(dbPath, (db) => {
      expect(
        all(
          db,
          `SELECT path, kind, service_group, last_modified, counts_created, size_bytes, stage,
             counts_json, applied_at FROM ingest_files ORDER BY counts_created`,
        ),
      ).toEqual([
        {
          path: 'complete/l_paging.zip',
          kind: 'weekly',
          service_group: 'paging',
          last_modified: PAGING_WEEKLY.lastModified,
          counts_created: '2026-09-27T13:38:53Z',
          size_bytes: PAGING_WEEKLY.zip.length,
          stage: 'complete',
          counts_json: JSON.stringify({ HD: 12, EN: 11, LO: 10, FR: 11 }),
          applied_at: '2026-09-29T20:00:00Z',
        },
        {
          path: 'complete/l_mdsitfs.zip',
          kind: 'weekly',
          service_group: 'mdsitfs',
          last_modified: MDSITFS_WEEKLY.lastModified,
          counts_created: '2026-09-27T13:40:45Z',
          size_bytes: MDSITFS_WEEKLY.zip.length,
          stage: 'complete',
          counts_json: JSON.stringify({ HD: 8, LL: 3 }),
          applied_at: '2026-09-29T20:00:00Z',
        },
        {
          path: 'complete/l_amat.zip',
          kind: 'weekly',
          service_group: 'amat',
          last_modified: AMAT_WEEKLY.lastModified,
          counts_created: '2026-09-27T13:44:10Z',
          size_bytes: AMAT_WEEKLY.zip.length,
          stage: 'complete',
          counts_json: JSON.stringify({ HD: 3, EN: 3, AM: 3 }),
          applied_at: '2026-09-29T20:00:00Z',
        },
      ]);
    });
  });

  it('empties the temp directory and releases the lock', async () => {
    expect(await readdir(mirror.tempDir)).toEqual([]);
    expect(existsSync(join(mirror.mirrorDir, LOCK_FILE))).toBe(false);
  });
});

describe('a status code filed in lower case', () => {
  it('is stored upper case, so its label resolves and a live one keeps its technical rows', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().set('complete/l_paging.zip', {
      ...PAGING_WEEKLY,
      zip: buildZip([
        { name: 'counts', data: countsFile('Sun Sep 27 09:38:53 EDT 2026', { HD: 2, LO: 1 }) },
        {
          name: 'HD.dat',
          data: datFile([
            hd({ usi: 6001, callsign: 'KZZ601', status: 'c', service: 'CD' }),
            hd({ usi: 6002, callsign: 'KZZ602', status: 'a', service: 'CD' }),
          ]),
        },
        {
          name: 'LO.dat',
          data: datFile([
            lo({ usi: 6002, number: 1, type: 'F', lat: [47, 10, 0, 'N'], lon: [122, 10, 0, 'W'] }),
          ]),
        },
      ]),
    });
    const { generation } = await fixtureIngester(mirror, { client, groups: ['paging'] }).rebuild();
    await readDb(join(mirror.mirrorDir, generation), (db) => {
      expect(all(db, 'SELECT usi, license_status FROM licenses ORDER BY usi')).toEqual([
        { usi: 6001, license_status: 'C' },
        { usi: 6002, license_status: 'A' },
      ]);
      expect(count(db, 'SELECT count(*) AS n FROM locations WHERE usi = 6002')).toBe(1);
    });
  });
});

describe('resume rule', () => {
  it('does not replay a step whose commit landed before the crash', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().withWeekly(['mdsitfs']);
    let crashed = false;
    const logger = {
      info: (message: string) => {
        if (message === 'Loaded license records' && !crashed) {
          crashed = true;
          throw new Error('Crashed right after the records commit.');
        }
      },
    };
    const ingester = fixtureIngester(mirror, { client, groups: ['mdsitfs'], logger });

    await expect(ingester.rebuild()).rejects.toThrow('Crashed right after the records commit.');
    expect(await readPointer(mirror.mirrorDir)).toBeUndefined();
    expect(existsSync(join(mirror.mirrorDir, LOCK_FILE))).toBe(false);

    const rerun = await ingester.rebuild();
    expect(rerun.status).toBe('rebuilt');
    expect(client.downloads('complete/l_mdsitfs.zip')).toBe(1);
    await readDb(join(mirror.mirrorDir, rerun.generation), (db) => {
      expect(count(db, 'SELECT count(*) AS n FROM licenses')).toBe(8);
      expect(
        all(
          db,
          'SELECT lease_usi, parent_usi, count(*) AS n FROM lease_links GROUP BY lease_usi, parent_usi ORDER BY lease_usi',
        ),
      ).toEqual([
        { lease_usi: 2002, parent_usi: 2001, n: 1 },
        { lease_usi: 2004, parent_usi: 2001, n: 1 },
        { lease_usi: 2006, parent_usi: 9999, n: 1 },
      ]);
      expect(count(db, 'SELECT count(*) AS n FROM locations')).toBe(3);
    });
  });

  it('resumes from the records stage when the technical step fails', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().withWeekly(['mdsitfs']);
    let opens = 0;
    const openArchive = (path: string) => {
      opens++;
      if (opens === 3) return Promise.reject(new Error('Archive read failed.'));
      return openZipArchive(path);
    };
    const ingester = fixtureIngester(mirror, { client, groups: ['mdsitfs'], openArchive });

    await expect(ingester.rebuild()).rejects.toThrow('Archive read failed.');
    const target = join(mirror.mirrorDir, 'fcc-uls-20260927T134047Z.db');
    await readDb(target, (db) => {
      expect(
        db
          .prepare<{ stage: string }>('SELECT stage FROM ingest_files WHERE path = ?')
          .get('complete/l_mdsitfs.zip')?.stage,
      ).toBe('records');
      expect(count(db, 'SELECT count(*) AS n FROM locations')).toBe(0);
    });
    const failed = createUlsStore(target);
    try {
      expect(await failed.readState()).toMatchObject({
        status: 'error',
        cursor: 'mdsitfs:records',
        error: 'Archive read failed.',
      });
    } finally {
      await failed.close();
    }

    const rerun = await ingester.rebuild();
    expect(rerun).toMatchObject({ status: 'rebuilt', generation: 'fcc-uls-20260927T134047Z.db' });
    expect(client.downloads('complete/l_mdsitfs.zip')).toBe(1);
    await readDb(target, (db) => {
      expect(count(db, 'SELECT count(*) AS n FROM licenses')).toBe(8);
      expect(count(db, 'SELECT count(*) AS n FROM lease_links')).toBe(3);
      expect(count(db, 'SELECT count(*) AS n FROM locations')).toBe(3);
      expect(count(db, 'SELECT count(*) AS n FROM market_blocks')).toBe(6);
    });
  });
});

describe('rebuild triggers and naming', () => {
  it('skips when every snapshot Last-Modified matches the published generation', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().withWeekly(['paging']);
    const ingester = fixtureIngester(mirror, { client, groups: ['paging'] });
    const first = await ingester.rebuild();
    const second = await ingester.rebuild();
    expect(second).toEqual({ status: 'skipped', generation: first.generation });
    expect(client.downloads('complete/l_paging.zip')).toBe(1);
  });

  it('builds a new generation from a newer snapshot and deletes stale generations only', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().withWeekly(['paging']);
    const ingester = fixtureIngester(mirror, { client, groups: ['paging'] });
    const first = await ingester.rebuild();
    const stale = 'fcc-uls-20260101T000000Z.db';
    for (const name of [stale, `${stale}-wal`, `${stale}-shm`, 'notes.txt', 'fcc-uls-x.db.bak']) {
      await writeFile(join(mirror.mirrorDir, name), 'x');
    }

    client.set('complete/l_paging.zip', nextWeek(PAGING_WEEKLY, '2026-10-04T13:38:55Z'));
    const second = await ingester.rebuild();
    expect(second).toMatchObject({ status: 'rebuilt', generation: 'fcc-uls-20261004T133855Z.db' });
    expect((await readPointer(mirror.mirrorDir))?.file).toBe('fcc-uls-20261004T133855Z.db');

    const names = await readdir(mirror.mirrorDir);
    expect(names).not.toContain(stale);
    expect(names).not.toContain(`${stale}-wal`);
    expect(names).not.toContain(`${stale}-shm`);
    expect(names).toContain('notes.txt');
    expect(names).toContain('fcc-uls-x.db.bak');
    // The generation that was published during the rebuild survives until the next one.
    expect(names).toContain(first.generation);
    expect(names).toContain(second.generation);
  });

  it('adds a -2 suffix when a group with a later Last-Modified joins in the same week', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().withWeekly(['paging', 'amat']);
    const first = await fixtureIngester(mirror, { client, groups: ['paging'] }).rebuild();
    expect(first.generation).toBe(FIXTURE_GENERATION);

    const second = await fixtureIngester(mirror, { client, groups: ['paging', 'amat'] }).rebuild();
    expect(second).toMatchObject({
      status: 'rebuilt',
      generation: 'fcc-uls-20260927T133855Z-2.db',
    });
    await readDb(join(mirror.mirrorDir, second.generation), (db) => {
      expect(count(db, 'SELECT count(*) AS n FROM licenses')).toBe(11);
    });
  });

  it('discards a retired generation built from other snapshots instead of building into it', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().withWeekly(['paging', 'amat', 'mdsitfs']);
    const info: unknown[][] = [];
    const rebuild = (groups: FixtureGroup[]) =>
      fixtureIngester(mirror, {
        client,
        groups,
        logger: { info: (...args) => info.push(args) },
      }).rebuild();
    const retired = FIXTURE_GENERATION;
    expect((await rebuild(['paging', 'amat'])).generation).toBe(retired);
    // amat is republished mid-week; paging, the earliest snapshot, keeps the name, so -2.
    const republished = '2026-09-29T09:00:00Z';
    client.set('complete/l_amat.zip', nextWeek(AMAT_WEEKLY, republished));
    expect((await rebuild(['paging', 'amat'])).generation).toBe('fcc-uls-20260927T133855Z-2.db');

    // Adding a group targets the primary name again: the retired file, complete for the old amat.
    const third = await rebuild(['paging', 'amat', 'mdsitfs']);
    expect(third).toMatchObject({ status: 'rebuilt', generation: retired });
    await readDb(join(mirror.mirrorDir, retired), (db) => {
      expect(
        all(db, "SELECT path, last_modified FROM ingest_files WHERE kind = 'weekly' ORDER BY path"),
      ).toEqual([
        { path: 'complete/l_amat.zip', last_modified: republished },
        { path: 'complete/l_mdsitfs.zip', last_modified: MDSITFS_WEEKLY.lastModified },
        { path: 'complete/l_paging.zip', last_modified: PAGING_WEEKLY.lastModified },
      ]);
      expect(count(db, 'SELECT count(*) AS n FROM licenses')).toBe(19);
    });
    expect(client.downloads('complete/l_amat.zip')).toBe(3);
    expect(info).toContainEqual([
      'Discarding a retired generation built from other snapshots; building it afresh.',
      { generation: retired },
    ]);
    expect((await rebuild(['paging', 'amat', 'mdsitfs'])).status).toBe('skipped');
  });

  it('rebuilds over a malformed current.json and republishes it, logging the pointer path', async () => {
    const mirror = await tempMirror();
    const pointerPath = join(mirror.mirrorDir, POINTER_FILE);
    await writeFile(pointerPath, '{"file": 42');
    const warnings: unknown[][] = [];
    const result = await fixtureIngester(mirror, {
      client: new FakeIngestClient().withWeekly(['paging']),
      groups: ['paging'],
      logger: { warning: (...args) => warnings.push(args) },
    }).rebuild();
    expect(result).toMatchObject({ status: 'rebuilt', generation: FIXTURE_GENERATION });
    expect(await readPointer(mirror.mirrorDir)).toEqual({
      file: FIXTURE_GENERATION,
      publishedAt: '2026-09-29T20:00:00Z',
    });
    expect(warnings).toEqual([
      ['current.json is malformed; the rebuild republishes it.', { pointerPath }],
    ]);
  });

  it('refuses to start while a live process holds the lock, and leaves its lock in place', async () => {
    const mirror = await tempMirror();
    const lockPath = join(mirror.mirrorDir, LOCK_FILE);
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, mode: 'refresh', startedAt: '2026-09-29T19:00:00Z' }),
    );
    const client = new FakeIngestClient().withWeekly(['paging']);
    await expect(
      fixtureIngester(mirror, { client, groups: ['paging'] }).rebuild(),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'ingest_locked', pid: process.pid },
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(client.calls).toEqual([]);
  });

  it.each([
    ['a dead PID', () => JSON.stringify({ pid: deadPid(), mode: 'init', startedAt: '' })],
    ['a truncated lock file', () => '{"pid": 12'],
  ])('reclaims a lock left with %s', async (_label, body) => {
    const mirror = await tempMirror();
    const lockPath = join(mirror.mirrorDir, LOCK_FILE);
    await writeFile(lockPath, body());
    const client = new FakeIngestClient().withWeekly(['paging']);
    const result = await fixtureIngester(mirror, { client, groups: ['paging'] }).rebuild();
    expect(result.status).toBe('rebuilt');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails with a conflict naming the path when a weekly snapshot is missing upstream', async () => {
    const mirror = await tempMirror();
    const client = new FakeIngestClient().withWeekly(['paging']);
    const rebuild = fixtureIngester(mirror, { client, groups: ['paging', 'amat'] }).rebuild();
    await expect(rebuild).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      message: expect.stringContaining('complete/l_amat.zip'),
      data: { path: 'complete/l_amat.zip' },
    });
    expect(client.calls.filter((call) => call.method === 'download')).toEqual([]);
    expect(existsSync(join(mirror.mirrorDir, LOCK_FILE))).toBe(false);
    expect(await readPointer(mirror.mirrorDir)).toBeUndefined();
  });
});

describe('daily refresh', () => {
  let mirror: TempMirror;
  let client: FakeIngestClient;

  /** Build paging + mdsitfs into a fresh mirror on the fixture clock. */
  async function built(): Promise<string> {
    mirror = await tempMirror();
    client = new FakeIngestClient().withWeekly(['paging', 'mdsitfs']);
    const { generation } = await fixtureIngester(mirror, {
      client,
      groups: ['paging', 'mdsitfs'],
    }).rebuild();
    return join(mirror.mirrorDir, generation);
  }

  const refresh = (now?: number) =>
    fixtureIngester(mirror, {
      client,
      groups: ['paging', 'mdsitfs'],
      ...(now !== undefined && { now }),
    }).refresh();

  async function checkpoint(dbPath: string): Promise<string | undefined> {
    const store = createUlsStore(dbPath);
    try {
      return (await store.readState()).checkpoint;
    } finally {
      await store.close();
    }
  }

  const services: UlsIndexService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it('fails with a conflict when no generation is published', async () => {
    mirror = await tempMirror();
    client = new FakeIngestClient();
    await expect(refresh()).rejects.toMatchObject({ code: JsonRpcErrorCode.Conflict });
    expect(existsSync(join(mirror.mirrorDir, LOCK_FILE))).toBe(false);
  });

  it('fails with a conflict when the pointer names a missing generation', async () => {
    mirror = await tempMirror();
    client = new FakeIngestClient();
    await writePointer(mirror.mirrorDir, {
      file: 'fcc-uls-20260101T000000Z.db',
      publishedAt: '2026-01-01T00:00:00Z',
    });
    await expect(refresh()).rejects.toMatchObject({ code: JsonRpcErrorCode.Conflict });
  });

  it('fails with the malformed-pointer error, naming mirror:init, when current.json is malformed', async () => {
    mirror = await tempMirror();
    client = new FakeIngestClient();
    await writeFile(join(mirror.mirrorDir, POINTER_FILE), '{"file": 42');
    await expect(refresh()).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: expect.stringContaining('rerun mirror:init'),
      data: { reason: 'malformed_pointer' },
    });
    expect(client.calls).toEqual([]);
    expect(existsSync(join(mirror.mirrorDir, LOCK_FILE))).toBe(false);
  });

  it('fails on a checkpoint older than six days and reports it while the index stays ready', async () => {
    const dbPath = await built();
    client.withDaily({ 'l_pg_mon.zip': DAILY_PG_MON });
    const errors: unknown[][] = [];
    const stale = fixtureIngester(mirror, {
      client,
      groups: ['paging', 'mdsitfs'],
      now: at('2026-10-04T00:00:00Z'),
      logger: { error: (...args) => errors.push(args) },
    });
    await expect(stale.refresh()).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'stale_checkpoint', checkpoint: '2026-09-27T13:38:53Z' },
    });
    expect(client.calls.filter((call) => call.method === 'list')).toEqual([]);
    // A failure the scheduler handles: recorded in the sync state, never logged as an error.
    expect(errors).toEqual([]);
    const store = createUlsStore(dbPath);
    try {
      expect(await store.readState()).toMatchObject({
        status: 'error',
        checkpoint: '2026-09-27T13:38:53Z',
        completedAt: expect.any(String),
        error: expect.stringContaining('more than six days old'),
      });
    } finally {
      await store.close();
    }

    const service = new UlsIndexService({
      mirrorDir: mirror.mirrorDir,
      pointerCheckMs: 0,
      redactIndividuals: true,
      services: ['paging', 'mdsitfs'],
    });
    services.push(service);
    expect(await service.ready()).toBe(true);
    const coverage = await service.coverage();
    expect(coverage.index).toMatchObject({ ready: true, status: 'ready' });
    expect(coverage.index.error).toContain('more than six days old');
  });

  it('replaces record sets by USI, skips unindexed codes, and keeps lease links whole', async () => {
    const dbPath = await built();
    client.withDaily({ 'l_mk_mon.zip': DAILY_MK_MON, 'l_pg_mon.zip': DAILY_PG_MON });
    const result = await refresh();
    expect(result.applied).toEqual(['daily/l_pg_mon.zip', 'daily/l_mk_mon.zip']);
    expect(await checkpoint(dbPath)).toBe('2026-09-28T12:02:00Z');

    await readDb(dbPath, (db) => {
      const license = (usi: number) =>
        db
          .prepare<{ license_status: string; licensee_name: string; service_group: string }>(
            'SELECT license_status, licensee_name, service_group FROM licenses WHERE usi = ?',
          )
          .get(usi);
      // 1001 cancelled and renamed: its technical rows go with the live status.
      expect(license(1001)).toEqual({
        license_status: 'C',
        licensee_name: 'Example Paging Co Renamed',
        service_group: 'paging',
      });
      expect(count(db, 'SELECT count(*) AS n FROM locations WHERE usi = 1001')).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM frequencies WHERE usi = 1001')).toBe(0);
      // 1006 moved from X to A on a new frequency.
      expect(license(1006)?.license_status).toBe('A');
      expect(
        all<{ frequency_mhz: number }>(
          db,
          'SELECT frequency_mhz FROM frequencies WHERE usi = 1006',
        ),
      ).toEqual([{ frequency_mhz: 153 }]);
      // 1100 is new under an indexed code; 1101's code is carried by no indexed group.
      expect(license(1100)).toMatchObject({ license_status: 'A', service_group: 'paging' });
      expect(
        db
          .prepare<{ emissions: string }>('SELECT emissions FROM frequencies WHERE usi = 1100')
          .get()?.emissions,
      ).toBe('11K2F3E');
      expect(license(1101)).toBeUndefined();
      expect(count(db, 'SELECT count(*) AS n FROM locations WHERE usi = 1101')).toBe(0);
      // The untouched expired record with the same callsign is still there.
      expect(license(1005)?.license_status).toBe('E');

      // Lease links: the re-sent lease keeps its parent link, the untouched lease keeps its own.
      expect(
        all(
          db,
          'SELECT lease_usi, parent_usi, count(*) AS n FROM lease_links GROUP BY lease_usi, parent_usi ORDER BY lease_usi',
        ),
      ).toEqual([
        { lease_usi: 2002, parent_usi: 2001, n: 1 },
        { lease_usi: 2004, parent_usi: 2001, n: 1 },
        { lease_usi: 2006, parent_usi: 9999, n: 1 },
      ]);
      // 2001 re-sent whole: one site and one block now.
      expect(count(db, 'SELECT count(*) AS n FROM locations WHERE usi = 2001')).toBe(1);
      expect(
        all(db, 'SELECT partition_area_id, lower FROM market_blocks WHERE usi = 2001'),
      ).toEqual([{ partition_area_id: 1, lower: 2496 }]);

      expect(stats(db, 'daily/l_pg_mon.zip').HD).toEqual({ read: 4, rejected: 0, kept: 3 });
      expect(
        all(
          db,
          "SELECT path, kind, stage, counts_created FROM ingest_files WHERE kind = 'daily' ORDER BY path",
        ),
      ).toEqual([
        {
          path: 'daily/l_mk_mon.zip',
          kind: 'daily',
          stage: 'complete',
          counts_created: '2026-09-28T12:02:00Z',
        },
        {
          path: 'daily/l_pg_mon.zip',
          kind: 'daily',
          stage: 'complete',
          counts_created: '2026-09-28T12:01:10Z',
        },
      ]);
      expect(all(db, "SELECT record_count FROM service_codes WHERE code = 'CD'")).toEqual([
        { record_count: 8 },
      ]);
    });
    expect(await readdir(mirror.tempDir)).toEqual([]);

    // The index service reads the refreshed generation the same way.
    const service = new UlsIndexService({
      mirrorDir: mirror.mirrorDir,
      pointerCheckMs: 0,
      redactIndividuals: true,
      services: ['paging', 'mdsitfs'],
    });
    services.push(service);
    const parent = await service.getLicense({ usi: '2001', maxFrequencies: 100 });
    const lease = await service.getLicense({ usi: '2002', maxFrequencies: 100 });
    expect(parent.found && parent.license.leases.map((entry) => entry.usi)).toEqual([
      '2002',
      '2004',
    ]);
    expect(lease.found && lease.license.leasedFrom).toEqual([{ callsign: 'KZZ801', usi: '2001' }]);
    expect((await service.coverage()).index.lastDailyApplied).toBe('2026-09-28T12:02:00Z');
  });

  it('skips files already applied or older than the checkpoint on a rerun', async () => {
    await built();
    client.withDaily({ 'l_pg_mon.zip': DAILY_PG_MON, 'l_mk_mon.zip': DAILY_MK_MON });
    await refresh();
    const downloadsBefore = client.calls.filter((call) => call.method === 'download').length;
    const rerun = await refresh();
    expect(rerun.applied).toEqual([]);
    expect(client.calls.filter((call) => call.method === 'download').length).toBe(downloadsBefore);
  });

  it('never applies a file older than the checkpoint; an empty day still advances it', async () => {
    const dbPath = await built();
    client.withDaily({ 'l_pg_sun.zip': DAILY_PG_SUN, 'l_pg_tue.zip': DAILY_PG_TUE });
    const result = await refresh();
    expect(result.applied).toEqual(['daily/l_pg_tue.zip']);
    expect(client.downloads('daily/l_pg_sun.zip')).toBe(0);
    expect(await checkpoint(dbPath)).toBe('2026-09-29T12:00:05Z');
    await readDb(dbPath, (db) => {
      // Sunday's file would have terminated 1001.
      expect(
        db
          .prepare<{ license_status: string }>(
            'SELECT license_status FROM licenses WHERE usi = 1001',
          )
          .get()?.license_status,
      ).toBe('A');
      expect(stats(db, 'daily/l_pg_tue.zip')).toEqual({});
    });
  });

  it('applies files oldest first and stops at the first failure, checkpoint at the last applied', async () => {
    const dbPath = await built();
    client.withDaily({
      'l_pg_tue.zip': DAILY_PG_TUE,
      'l_mk_mon.zip': DAILY_MK_MON,
      'l_pg_mon.zip': DAILY_PG_MON,
    });
    client.failDownloads.add('daily/l_mk_mon.zip');
    await expect(refresh()).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });

    expect(
      client.calls.filter((call) => call.method === 'download' && call.path?.startsWith('daily/')),
    ).toEqual([
      { method: 'download', path: 'daily/l_pg_mon.zip' },
      { method: 'download', path: 'daily/l_mk_mon.zip' },
    ]);
    expect(await checkpoint(dbPath)).toBe('2026-09-28T12:01:10Z');
    await readDb(dbPath, (db) => {
      expect(
        all<{ path: string }>(db, "SELECT path FROM ingest_files WHERE kind = 'daily'").map(
          (row) => row.path,
        ),
      ).toEqual(['daily/l_pg_mon.zip']);
    });
    expect(existsSync(join(mirror.mirrorDir, LOCK_FILE))).toBe(false);
  });

  it('widens the band bounds with each daily file, so a refresh that stops partway still finds every committed row', async () => {
    const dbPath = await built();
    client.withDaily({ 'l_mw_mon.zip': DAILY_WIDE_MON, 'l_mk_mon.zip': DAILY_MK_MON });
    client.failDownloads.add('daily/l_mk_mon.zip');
    await expect(refresh()).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });

    await readDb(dbPath, (db) => {
      const meta = (key: string) =>
        Number(
          db.prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?').get(key)?.value,
        );
      const widest = (sql: string) => db.prepare<{ widest: number }>(sql).get()?.widest;
      expect(widest('SELECT max(occ_high - occ_low) AS widest FROM frequencies')).toBe(50);
      expect(meta('max_site_band_mhz')).toBeGreaterThanOrEqual(50);
      expect(
        widest('SELECT max(COALESCE(upper, lower) - lower) AS widest FROM market_blocks'),
      ).toBe(34);
      expect(meta('max_market_band_mhz')).toBeGreaterThanOrEqual(34);
    });

    // Near each wide row's upper edge, the range scans reach back to its lower edge.
    const service = new UlsIndexService({
      mirrorDir: mirror.mirrorDir,
      pointerCheckMs: 0,
      redactIndividuals: true,
      services: ['paging', 'mdsitfs'],
    });
    services.push(service);
    const usisAt = async (mhz: number) => {
      const result = await service.searchFrequencies({
        band: { lowMhz: mhz, highMhz: mhz },
        kind: 'both',
        limit: 50,
        status: 'A',
      });
      return result.ok ? result.rows.map((row) => `${row.kind}:${row.usi}`) : result.reason;
    };
    expect(await usisAt(494)).toEqual(['site:1200']);
    expect(await usisAt(2573)).toEqual(['market:2100']);
  });
});

describe('marketStates', () => {
  it.each([
    ['Fargo-Moorhead, ND-MN', ',ND,MN,'],
    ['Bakersfield, CA', ',CA,'],
    ['Sample Market/Other, ND/SD', ',ND,SD,'],
    ['Washington, DC-MD-VA', ',DC,MD,VA,'],
    ['San Juan, PR', ',PR,'],
    ['Somewhere, nd', ',ND,'],
    ['Twin Town, ND-ND', ',ND,'],
    ['Comma, Town, WA', ',WA,'],
    ['Odd Spacing,  OR - WA ', ',OR,WA,'],
  ])('%j → %j', (name, expected) => {
    expect(marketStates(name)).toBe(expected);
  });

  it.each([
    ['P35 GSA', 'no comma'],
    ['Long Market Name Cut Off, N', 'a name cut before its state'],
    ['Somewhere, ZZ', 'no recognizable code'],
    ['', 'an empty name'],
  ])('%j → null (%s)', (name) => {
    expect(marketStates(name)).toBeNull();
  });

  it('returns null for a missing name', () => {
    expect(marketStates(null)).toBeNull();
  });
});
