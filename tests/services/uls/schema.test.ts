/**
 * @fileoverview Tests for the index store spec: generation file naming, the `current.json`
 * pointer and ingest-lock readers and writers, the inherited-lock cleanup, process liveness,
 * and the tables a fresh store creates.
 * @module tests/services/uls/schema.test
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError, serializationError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bandClassBounds,
  bandClassSql,
  clearInheritedLock,
  compactStamp,
  createUlsStore,
  generationFileName,
  generationStamp,
  isGenerationFile,
  isMalformedPointer,
  isProcessAlive,
  LEASE_CALLSIGN,
  LICENSE_COLUMNS,
  LOCK_FILE,
  POINTER_FILE,
  readIngestLock,
  readPointer,
  writePointer,
} from '@/services/uls/schema.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fcc-schema-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('compactStamp', () => {
  it('drops dashes and colons from an ISO time', () => {
    expect(compactStamp('2026-09-27T13:38:53Z')).toBe('20260927T133853Z');
  });

  it('drops fractional seconds', () => {
    expect(compactStamp('2026-09-27T13:38:53.123Z')).toBe('20260927T133853Z');
  });
});

describe('generationFileName, generationStamp, and isGenerationFile', () => {
  it('names a generation from its stamp, with an optional suffix', () => {
    expect(generationFileName('20260927T133853Z')).toBe('fcc-uls-20260927T133853Z.db');
    expect(generationFileName('20260927T133853Z', '2')).toBe('fcc-uls-20260927T133853Z-2.db');
  });

  it('reads the stamp and suffix back from a generation file name', () => {
    expect(generationStamp('fcc-uls-20260927T133853Z.db')).toBe('20260927T133853Z');
    expect(generationStamp(generationFileName('20260927T133853Z', '2'))).toBe('20260927T133853Z-2');
  });

  it('recognizes generation files only', () => {
    expect(isGenerationFile('fcc-uls-20260927T133853Z.db')).toBe(true);
    expect(isGenerationFile('fcc-uls-20260927T133853Z-2.db')).toBe(true);
    expect(isGenerationFile('fcc-uls-20260927T133853Z.db-wal')).toBe(false);
    expect(isGenerationFile('fcc-uls-20260927T133853Z.db-shm')).toBe(false);
    expect(isGenerationFile('current.json')).toBe(false);
    expect(isGenerationFile('ingest.lock')).toBe(false);
    expect(isGenerationFile('other-20260927.db')).toBe(false);
    expect(isGenerationFile('')).toBe(false);
  });

  it('accepts what generationFileName produces', () => {
    expect(isGenerationFile(generationFileName(compactStamp('2026-01-02T03:04:05Z'), '3'))).toBe(
      true,
    );
  });
});

describe('LEASE_CALLSIGN', () => {
  it('matches an L followed by nine digits, and nothing looser', () => {
    expect(LEASE_CALLSIGN.test('L000012345')).toBe(true);
    expect(LEASE_CALLSIGN.test('L00001234')).toBe(false);
    expect(LEASE_CALLSIGN.test('L0000123456')).toBe(false);
    expect(LEASE_CALLSIGN.test('KA1234567')).toBe(false);
  });
});

describe('band classes', () => {
  /** Widths in MHz paired with the class bandClassSql assigns them. */
  const CASES: [width: number | null, bandClass: number | null][] = [
    [0, -14],
    [2 ** -14, -14],
    [2 ** -14 * 1.001, -13],
    [0.0125, -6],
    [0.0625, -4],
    [0.0626, -3],
    [3100, 12],
    [8192, 13],
    [8192.5, 14],
    [1e6, 14],
    [null, null],
  ];

  it('assigns the smallest power-of-two class a width fits, the open class above 8192 MHz', async () => {
    const store = createUlsStore(join(dir, 'gen.db'));
    try {
      const query = (await store.raw()).prepare<{ c: number | null }>(
        `SELECT ${bandClassSql('w')} AS c FROM (SELECT ? AS w)`,
      );
      for (const [width, bandClass] of CASES) {
        expect(query.get(width)?.c, String(width)).toBe(bandClass);
      }
    } finally {
      await store.close();
    }
  });

  it('bounds every class by a width no row in it exceeds, the open class by the widest band', () => {
    const bounds = new Map(bandClassBounds(19_000));
    expect([...bounds.keys()]).toEqual(Array.from({ length: 29 }, (_, i) => i - 14));
    expect(bounds.get(14)).toBe(19_000);
    for (const [width, bandClass] of CASES) {
      if (width === null || bandClass === null || bandClass === 14) continue;
      expect(bounds.get(bandClass), String(width)).toBeGreaterThanOrEqual(width);
    }
  });
});

describe('readPointer', () => {
  it('returns undefined when there is no pointer', async () => {
    expect(await readPointer(dir)).toBeUndefined();
  });

  it('reads a well-formed pointer', async () => {
    await writeFile(
      join(dir, POINTER_FILE),
      JSON.stringify({ file: 'fcc-uls-20260927T133853Z.db', publishedAt: '2026-09-29T20:00:00Z' }),
    );
    expect(await readPointer(dir)).toEqual({
      file: 'fcc-uls-20260927T133853Z.db',
      publishedAt: '2026-09-29T20:00:00Z',
    });
  });

  it('ignores extra fields', async () => {
    await writeFile(
      join(dir, POINTER_FILE),
      JSON.stringify({ file: 'fcc-uls-1.db', publishedAt: 'now', extra: true }),
    );
    expect(await readPointer(dir)).toEqual({ file: 'fcc-uls-1.db', publishedAt: 'now' });
  });

  it.each([
    ['invalid JSON', '{"file": "fcc-uls-1.db"'],
    ['an empty file', ''],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['a missing publishedAt', JSON.stringify({ file: 'fcc-uls-1.db' })],
    ['a missing file', JSON.stringify({ publishedAt: 'now' })],
    ['a non-string file', JSON.stringify({ file: 7, publishedAt: 'now' })],
    ['a non-generation file name', JSON.stringify({ file: 'evil.db', publishedAt: 'now' })],
    ['a WAL sidecar name', JSON.stringify({ file: 'fcc-uls-1.db-wal', publishedAt: 'now' })],
    ['a non-string publishedAt', JSON.stringify({ file: 'fcc-uls-1.db', publishedAt: 5 })],
  ])('throws a path-free malformed_pointer SerializationError for %s', async (_label, body) => {
    await writeFile(join(dir, POINTER_FILE), body);
    const error = await readPointer(dir).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'current.json is not a valid generation pointer; rerun mirror:init to republish it.',
    });
    expect((error as McpError).data).toEqual({ reason: 'malformed_pointer' });
    expect(isMalformedPointer(error)).toBe(true);
  });

  it('isMalformedPointer is false for every other failure', () => {
    expect(isMalformedPointer(serializationError('Bad zip', { reason: 'other' }))).toBe(false);
    expect(isMalformedPointer(new Error('malformed_pointer'))).toBe(false);
    expect(isMalformedPointer({ data: { reason: 'malformed_pointer' } })).toBe(false);
    expect(isMalformedPointer(undefined)).toBe(false);
  });
});

describe('writePointer', () => {
  it('publishes a pointer readPointer can read back, leaving no temp file', async () => {
    const pointer = { file: 'fcc-uls-20260927T133853Z.db', publishedAt: '2026-09-29T20:00:00Z' };
    await writePointer(dir, pointer);
    expect(await readPointer(dir)).toEqual(pointer);
    expect(await readdir(dir)).toEqual([POINTER_FILE]);
    expect((await readFile(join(dir, POINTER_FILE), 'utf8')).endsWith('\n')).toBe(true);
  });

  it('replaces an existing pointer', async () => {
    await writePointer(dir, { file: 'fcc-uls-1.db', publishedAt: 'first' });
    await writePointer(dir, { file: 'fcc-uls-2.db', publishedAt: 'second' });
    expect(await readPointer(dir)).toEqual({ file: 'fcc-uls-2.db', publishedAt: 'second' });
    expect(await readdir(dir)).toEqual([POINTER_FILE]);
  });
});

describe('readIngestLock', () => {
  it('returns undefined when there is no lock file', async () => {
    expect(await readIngestLock(dir)).toBeUndefined();
  });

  it('reads the holder recorded in the lock', async () => {
    await writeFile(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 4242, mode: 'refresh', startedAt: '2026-09-29T20:00:00Z' }),
    );
    expect(await readIngestLock(dir)).toEqual({
      pid: 4242,
      mode: 'refresh',
      startedAt: '2026-09-29T20:00:00Z',
    });
  });

  it('fills defaults for missing mode and start time', async () => {
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 7 }));
    expect(await readIngestLock(dir)).toEqual({ pid: 7, mode: 'unknown', startedAt: '' });
  });

  it('reports a truncated lock file as an unknown holder with a NaN PID', async () => {
    await writeFile(join(dir, LOCK_FILE), '{"pid": 42');
    const holder = await readIngestLock(dir);
    expect(holder).toMatchObject({ mode: 'unknown', startedAt: '' });
    expect(Number.isNaN(holder?.pid)).toBe(true);
  });

  it('reports an empty lock file as an unknown holder with a NaN PID', async () => {
    await writeFile(join(dir, LOCK_FILE), '');
    expect(Number.isNaN((await readIngestLock(dir))?.pid)).toBe(true);
  });

  it('reads a lock without a numeric PID as NaN', async () => {
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ mode: 'init' }));
    const holder = await readIngestLock(dir);
    expect(Number.isNaN(holder?.pid)).toBe(true);
    expect(holder?.mode).toBe('init');
  });
});

describe('clearInheritedLock', () => {
  it('removes a lock naming this process and returns its holder', async () => {
    const holder = { pid: process.pid, mode: 'init', startedAt: '2026-09-29T19:00:00Z' };
    await writeFile(join(dir, LOCK_FILE), JSON.stringify(holder));
    expect(await clearInheritedLock(dir)).toEqual(holder);
    expect(await readdir(dir)).toEqual([]);
  });

  it('leaves a lock naming any other process', async () => {
    const body = JSON.stringify({ pid: process.pid + 1, mode: 'refresh', startedAt: '' });
    await writeFile(join(dir, LOCK_FILE), body);
    expect(await clearInheritedLock(dir)).toBeUndefined();
    expect(await readFile(join(dir, LOCK_FILE), 'utf8')).toBe(body);
  });

  it('is a no-op without a lock file or a mirror directory', async () => {
    expect(await clearInheritedLock(dir)).toBeUndefined();
    expect(await clearInheritedLock(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for a process that has exited', () => {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(child.pid).toBeGreaterThan(0);
    expect(isProcessAlive(child.pid)).toBe(false);
  });

  it('is false for NaN, the value a truncated lock file yields', () => {
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

describe('createUlsStore', () => {
  it('creates the licenses table, its FTS index, and every auxiliary table', async () => {
    const store = createUlsStore(join(dir, 'gen.db'));
    try {
      const db = await store.raw();
      const tables = new Set(
        db
          .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      for (const table of [
        'licenses',
        'lease_links',
        'locations',
        'antennas',
        'frequencies',
        'market_blocks',
        'service_codes',
        'ingest_files',
        'meta',
      ]) {
        expect(tables, table).toContain(table);
      }
      expect([...tables].some((name) => name.startsWith('licenses_fts'))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('gives licenses every declared column', async () => {
    const store = createUlsStore(join(dir, 'gen.db'));
    try {
      const db = await store.raw();
      const columns = db
        .prepare<{ name: string }>("SELECT name FROM pragma_table_info('licenses')")
        .all()
        .map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(Object.keys(LICENSE_COLUMNS)));
    } finally {
      await store.close();
    }
  });

  it('creates the lookup indexes on the auxiliary tables', async () => {
    const store = createUlsStore(join(dir, 'gen.db'));
    try {
      const db = await store.raw();
      const indexes = new Set(
        db
          .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .map((row) => row.name),
      );
      for (const index of [
        'lease_links_lease',
        'lease_links_parent',
        'locations_key',
        'locations_coords',
        'locations_site_state',
        'antennas_key',
        'frequencies_key',
        'frequencies_band',
        'market_blocks_usi',
        'market_blocks_band',
      ]) {
        expect(indexes, index).toContain(index);
      }
    } finally {
      await store.close();
    }
  });

  it('enforces the keys of the bookkeeping tables but not the upstream-data tables', async () => {
    const store = createUlsStore(join(dir, 'gen.db'));
    try {
      const db = await store.raw();
      db.exec("INSERT INTO meta (key, value) VALUES ('k', 'v')");
      expect(() => db.exec("INSERT INTO meta (key, value) VALUES ('k', 'w')")).toThrow();
      db.exec("INSERT INTO service_codes (code, service_group) VALUES ('CD', 'paging')");
      expect(() =>
        db.exec("INSERT INTO service_codes (code, service_group) VALUES ('CD', 'paging')"),
      ).toThrow();
      db.exec('INSERT INTO lease_links (lease_usi, parent_usi) VALUES (1, 2), (1, 2)');
      expect(db.prepare<{ n: number }>('SELECT count(*) AS n FROM lease_links').get()?.n).toBe(2);
    } finally {
      await store.close();
    }
  });

  it('reopens an existing generation without recreating or losing data', async () => {
    const path = join(dir, 'gen.db');
    const first = createUlsStore(path);
    try {
      (await first.raw()).exec("INSERT INTO meta (key, value) VALUES ('kept', 'yes')");
    } finally {
      await first.close();
    }
    const second = createUlsStore(path);
    try {
      const row = (await second.raw())
        .prepare<{ value: string }>("SELECT value FROM meta WHERE key = 'kept'")
        .get();
      expect(row?.value).toBe('yes');
    } finally {
      await second.close();
    }
  });

  it('numbers the sites filed under each location number when upgrading a schema 1 generation', async () => {
    const path = join(dir, 'gen.db');
    const v1 = createUlsStore(path);
    try {
      // The schema 1 layout: no site_seq column, stamped version 1.
      (await v1.raw()).exec(
        `ALTER TABLE locations DROP COLUMN site_seq;
         INSERT INTO locations (usi, location_number) VALUES (7, 1), (7, 2), (7, 1), (8, 1), (7, 1);
         UPDATE schema_version SET version = 1;`,
      );
    } finally {
      await v1.close();
    }
    const upgraded = createUlsStore(path);
    try {
      const rows = (await upgraded.raw())
        .prepare<{ location_number: number; site_seq: number; usi: number }>(
          'SELECT usi, location_number, site_seq FROM locations ORDER BY rowid',
        )
        .all();
      expect(rows.map((row) => [row.usi, row.location_number, row.site_seq])).toEqual([
        [7, 1, 1],
        [7, 2, 1],
        [7, 1, 2],
        [8, 1, 1],
        [7, 1, 3],
      ]);
    } finally {
      await upgraded.close();
    }
  });

  it('classes the frequencies and market blocks by width when upgrading a schema 2 generation', async () => {
    const path = join(dir, 'gen.db');
    const v2 = createUlsStore(path);
    try {
      // The schema 2 layout: no band_class columns, lower-edge-only indexes, stamped version 2.
      (await v2.raw()).exec(
        `DROP INDEX frequencies_band;
         DROP INDEX market_blocks_band;
         ALTER TABLE frequencies DROP COLUMN band_class;
         ALTER TABLE market_blocks DROP COLUMN band_class;
         CREATE INDEX frequencies_occ_low ON frequencies (occ_low);
         CREATE INDEX market_blocks_lower ON market_blocks (lower);
         INSERT INTO frequencies (usi, location_number, antenna_number, freq_seq_id, occ_low, occ_high)
           VALUES (1, 1, 1, 1, 152.24, 152.24), (1, 1, 1, 2, 152.234, 152.246),
                  (1, 1, 1, 3, 15700, 17300), (1, 1, 1, 4, NULL, NULL);
         INSERT INTO market_blocks (usi, partition_area_id, lower, upper)
           VALUES (2, 0, 1850, 1865), (2, 0, 0, 10), (2, 0, 3000, 8000), (2, 0, 3700, NULL);
         UPDATE schema_version SET version = 2;`,
      );
    } finally {
      await v2.close();
    }
    const upgraded = createUlsStore(path);
    try {
      const db = await upgraded.raw();
      const classes = (table: string) =>
        db
          .prepare<{ band_class: number | null }>(`SELECT band_class FROM ${table} ORDER BY rowid`)
          .all()
          .map((row) => row.band_class);
      expect(classes('frequencies')).toEqual([-14, -6, 11, null]);
      expect(classes('market_blocks')).toEqual([4, 4, 13, -14]);
      const indexes = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining(['frequencies_band', 'market_blocks_band']));
      expect(indexes).not.toContain('frequencies_occ_low');
      expect(indexes).not.toContain('market_blocks_lower');
    } finally {
      await upgraded.close();
    }
  });

  it('opens nothing until first use', async () => {
    const store = createUlsStore(join(dir, 'lazy.db'));
    expect(await readdir(dir)).toEqual([]);
    await store.close();
  });
});
