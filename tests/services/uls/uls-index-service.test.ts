/**
 * @fileoverview Tests for `UlsIndexService` over a generation the real ingester builds from
 * the fixture zips: cold-index behavior (not ready, building, failed build, dangling and
 * malformed pointer), stored errors and read failures (an unreadable pointer, a generation
 * that will not open) kept free of the mirror path, readiness and service
 * codes, `searchLicenses`, `getLicense` (from a location offset or number; the location windows
 * of records without paths pinned as they were before paths; microwave paths under their transmit
 * antennas, the 100-path window budget, a daily file's replacement paths, and the path-coverage
 * mark of a migrated generation), `findTransmitters`,
 * `searchFrequencies` (redaction on and off, site names and addresses included), the ASR
 * registration-number rule, operating areas (location type, radius of operation, and the
 * location type filter), and the switch to a newly published generation.
 * @module tests/services/uls/uls-index-service.test
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVICE_GROUPS, USPS_CODES } from '@/services/uls/codes.js';
import {
  createUlsStore,
  LOCK_FILE,
  META_KEYS,
  POINTER_FILE,
  writePointer,
} from '@/services/uls/schema.js';
import type {
  Band,
  FindTransmittersParams,
  FrequencyAssignment,
  GetLicenseParams,
  GetLicenseResult,
  LicenseSummary,
  PageResult,
  SearchFrequenciesParams,
  SearchLicensesParams,
  TransmitterSite,
} from '@/services/uls/types.js';
import { radioServiceLabel, UlsIndexService } from '@/services/uls/uls-index-service.js';
import {
  AREA_SITES_WEEKLY,
  an,
  BAND_CLASS_WEEKLY,
  DAILY_MW_MON,
  DAILY_PG_MON,
  DATA_QUALITY_WEEKLY,
  en,
  FakeIngestClient,
  type FixtureFile,
  fr,
  hd,
  INDIVIDUAL_SITES_WEEKLY,
  lo,
  MARKET_CODES_WEEKLY,
  MARKET_STATES_WEEKLY,
  MICRO_WEEKLY,
  PAGING_WEEKLY,
  pa,
  QUIRKS_WEEKLY,
  recordsZip,
  sprawlingPagingWeekly,
} from '../../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  FIXTURE_GENERATION,
  FIXTURE_GROUPS,
  type FixtureIndex,
  fixtureIngester,
  makeTempMirror,
  type TempMirror,
} from '../../fixtures/uls-index.js';

/** Decimal degrees of a DMS fixture coordinate. */
const dms = (deg: number, min: number, sec: number, negative = false) =>
  (negative ? -1 : 1) * (deg + min / 60 + sec / 3600);

const SEATTLE_SITE = { latitude: dms(47, 36, 22.3), longitude: dms(122, 19, 55.6, true) };

/** A cursor shaped like the service's, for a generation and tag of the test's choosing. */
const forgeCursor = (...parts: unknown[]) =>
  Buffer.from(JSON.stringify(parts)).toString('base64url');

/** Unwrap an `ok` page or fail the test. */
function page<T>(result: PageResult<T>): {
  nextCursor?: string;
  rows: T[];
  total: number;
  totalIsLowerBound?: boolean;
} {
  if (!result.ok) throw new Error(`Expected a page, got ${result.reason}.`);
  return result;
}

/** Follow every cursor and collect all rows, asserting the total is stable across pages. */
async function allPages<T>(
  fetch: (cursor?: string) => Promise<PageResult<T>>,
): Promise<{ pages: number; rows: T[]; total: number }> {
  const first = page(await fetch());
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const next = page(await fetch(cursor));
    expect(next.total).toBe(first.total);
    rows.push(...next.rows);
    cursor = next.nextCursor;
    pages++;
  }
  return { pages, rows, total: first.total };
}

const usis = (rows: { usi: string }[]) => rows.map((row) => row.usi);

const licenses = (overrides: Partial<SearchLicensesParams>): SearchLicensesParams => ({
  limit: 50,
  status: 'any',
  ...overrides,
});

const transmitters = (overrides: Partial<FindTransmittersParams>): FindTransmittersParams => ({
  ...SEATTLE_SITE,
  radiusKm: 5,
  limit: 50,
  maxFrequenciesPerSite: 50,
  status: 'A',
  ...overrides,
});

const band = (lowMhz: number, highMhz = lowMhz): Band => ({ lowMhz, highMhz });

const frequencies = (overrides: Partial<SearchFrequenciesParams>): SearchFrequenciesParams => ({
  band: band(2496, 2530),
  kind: 'both',
  limit: 50,
  status: 'A',
  ...overrides,
});

/**
 * search_frequencies limits that send every side with more than one candidate through the
 * band walk, one window or two per call: the early stop runs on nearly every page.
 */
const WALK_LIMITS = { exactCap: 1, walkBudget: 2, windowTarget: 1 } as const;

/**
 * Every row of a frequency search, following each nextCursor, with the pages that ended
 * short of the limit while still carrying a cursor, and whether any total was a lower bound.
 */
async function walkFrequencies(
  service: UlsIndexService,
  params: SearchFrequenciesParams,
): Promise<{ lowerBound: boolean; rows: FrequencyAssignment[]; shortPages: number }> {
  const rows: FrequencyAssignment[] = [];
  let cursor: string | undefined;
  let shortPages = 0;
  let lowerBound = false;
  for (let calls = 0; ; calls++) {
    if (calls > 1000) throw new Error('The cursor walk did not end.');
    const next = page(await service.searchFrequencies({ ...params, cursor }));
    rows.push(...next.rows);
    if (next.nextCursor && next.rows.length < params.limit) shortPages++;
    lowerBound ||= next.totalIsLowerBound === true;
    cursor = next.nextCursor;
    if (!cursor) return { lowerBound, rows, shortPages };
  }
}

/** `kind:usi:location-or-frequency` labels for search_frequencies rows. */
const assignmentKeys = (rows: FrequencyAssignment[]) =>
  rows.map((row) =>
    row.kind === 'site'
      ? `site:${row.usi}:${row.locationNumber}`
      : `market:${row.usi}:${row.frequencyMhz}`,
  );

const mirrors: TempMirror[] = [];
const services: UlsIndexService[] = [];

/** A service over an empty (cold) mirror directory. */
async function coldService(): Promise<{ mirror: TempMirror; service: UlsIndexService }> {
  const mirror = await makeTempMirror('cold');
  mirrors.push(mirror);
  const service = new UlsIndexService({
    mirrorDir: mirror.mirrorDir,
    pointerCheckMs: 0,
    redactIndividuals: true,
    services: FIXTURE_GROUPS,
  });
  services.push(service);
  return { mirror, service };
}

let fixture: FixtureIndex;
let on: UlsIndexService;
let off: UlsIndexService;

beforeAll(async () => {
  fixture = await buildFixtureIndex();
  on = fixture.service({ redactIndividuals: true });
  off = fixture.service({ redactIndividuals: false });
});

afterAll(async () => {
  await Promise.all(services.map((service) => service.close()));
  await fixture?.dispose();
  await Promise.all(mirrors.map((mirror) => mirror.remove()));
});

describe('filed location classes', () => {
  let index: FixtureIndex;
  let service: UlsIndexService;
  beforeAll(async () => {
    index = await buildFixtureIndex({
      groups: ['paging'],
      weekly: { paging: DATA_QUALITY_WEEKLY },
    });
    service = index.service();
  });
  afterAll(async () => {
    await index.dispose();
  });

  it('keeps independent unnumbered records and whole-location budgets across every window', async () => {
    const first = await service.getLicense({ callsign: 'KZZ541', maxFrequencies: 1 });
    expect(first).toMatchObject({ found: true, nextLocationOffset: 1, frequenciesShown: 1 });
    if (!first.found) throw new Error('Missing fixture');
    expect(first.locations.map((entry) => entry.locationNumber)).toEqual([1]);
    expect(first.locations[0]?.antennas).toEqual([
      expect.objectContaining({ antennaNumber: 1, make: 'AGREED', recordCount: 2 }),
    ]);
    expect(first.locations[0]?.antennas[0]).not.toHaveProperty('model');
    const second = await service.getLicense({
      callsign: 'KZZ541',
      locationOffset: 1,
      maxFrequencies: 1,
    });
    expect(second).toMatchObject({
      found: true,
      nextLocationOffset: 2,
      frequencyTotal: 6,
      sitesShown: 2,
    });
    if (!second.found) throw new Error('Missing fixture');
    expect(second.locations.map((entry) => entry.locationNumber)).toEqual([2]);
    const unnumbered = second.locations[0]!.antennas.filter(
      (entry) => entry.antennaNumber === undefined,
    );
    expect(unnumbered).toHaveLength(101);
    expect(unnumbered.map((entry) => entry.model)).toEqual([
      'DUPLICATE',
      'DUPLICATE',
      ...Array.from({ length: 99 }, (_, i) => `MODEL${i + 2}`),
    ]);
    expect(
      unnumbered.every(
        (entry) => entry.frequencies.length === 0 && entry.recordCount === undefined,
      ),
    ).toBe(true);
    expect(
      second.locations[0]?.antennas.find((entry) => entry.antennaNumber === 1)?.frequencies,
    ).toHaveLength(1);
    const last = await service.getLicense({
      callsign: 'KZZ541',
      locationOffset: 2,
      maxFrequencies: 10,
    });
    expect(last).toMatchObject({
      found: true,
      locations: [
        { locationNumber: 3 },
        { locationNumber: 4 },
        { locationNumber: 5 },
        { locationNumber: 6 },
        { locationNumber: 7 },
      ],
    });
    expect(last).not.toHaveProperty('nextLocationOffset');
    expect(
      await service.getLicense({ callsign: 'KZZ541', locationOffset: 99, maxFrequencies: 1 }),
    ).toMatchObject({ found: true, locations: [], frequenciesShown: 0 });
  });

  it('omits invalid decimals on detail and frequency search while retaining filed state and classes', async () => {
    const detail = await service.getLicense({
      callsign: 'KZZ541',
      locationNumber: 6,
      maxFrequencies: 10,
    });
    expect(detail).toMatchObject({
      found: true,
      locations: [
        {
          locationNumber: 6,
          state: 'NY',
          coordinatesDms: '0-0-0 N 0-0-0 W',
          locationClassLabel: 'Transmit Location',
        },
        { locationNumber: 7 },
      ],
    });
    if (!detail.found) throw new Error('Missing fixture');
    expect(detail.locations[0]).not.toHaveProperty('latitude');
    expect(detail.locations[0]).not.toHaveProperty('longitude');
    const rows = page(
      await service.searchFrequencies(frequencies({ band: band(152, 157), kind: 'site' })),
    ).rows;
    expect(rows[0]).toMatchObject({
      locationClassCode: 'T',
      locationClassLabel: 'Transmit Location',
    });
    expect(rows[1]).not.toHaveProperty('locationClassCode');
    expect(rows[1]).not.toHaveProperty('locationClassLabel');
    expect(rows[3]).toMatchObject({ locationClassCode: 'Z' });
    expect(rows[3]).not.toHaveProperty('locationClassLabel');
    expect(rows[5]).toMatchObject({ state: 'NY', stateFromCoordinates: false });
    expect(rows[5]).not.toHaveProperty('latitude');
    expect(rows[5]).not.toHaveProperty('longitude');
    expect(
      page(
        await service.findTransmitters(transmitters({ latitude: 0, longitude: 0, radiusKm: 0.1 })),
      ).rows,
    ).toEqual([]);
  });

  it('filters each site before totals and every cursor page without losing shared-number ambiguity', async () => {
    const base = transmitters({ latitude: 47, longitude: -122, radiusKm: 5, limit: 1 });
    const all = await allPages((cursor) => service.findTransmitters({ ...base, cursor }));
    expect(all.rows.map((row) => row.locationNumber)).toEqual([1, 2, 2, 3, 4, 5]);
    for (const code of ['T', 'R', 'P']) {
      const selected = await allPages((cursor) =>
        service.findTransmitters({ ...base, locationClass: code, cursor }),
      );
      expect(selected.rows).toEqual(all.rows.filter((row) => row.locationClassCode === code));
      expect(selected.total).toBe(selected.rows.length);
    }
    expect(all.rows[0]).toMatchObject({
      locationClassCode: 'T',
      locationClassLabel: 'Transmit Location',
    });
    expect(all.rows[1]).toMatchObject({
      locationClassCode: 'R',
      locationClassLabel: 'Receive Location',
      sitesSharingNumber: 2,
    });
    expect(all.rows[4]).toMatchObject({ locationClassCode: 'Z' });
    expect(all.rows[4]).not.toHaveProperty('locationClassLabel');
    expect(all.rows[5]).not.toHaveProperty('locationClassCode');
  });
});

describe('cold index', () => {
  const notReady = {
    code: JsonRpcErrorCode.ServiceUnavailable,
    data: { reason: 'index_not_ready' },
  };

  it('fails every query with index_not_ready', async () => {
    const { service } = await coldService();
    await expect(service.searchLicenses(licenses({}))).rejects.toMatchObject(notReady);
    await expect(
      service.getLicense({ callsign: 'KZZ901', maxFrequencies: 10 }),
    ).rejects.toMatchObject(notReady);
    await expect(service.findTransmitters(transmitters({}))).rejects.toMatchObject(notReady);
    await expect(service.searchFrequencies(frequencies({}))).rejects.toMatchObject(notReady);
    await expect(service.searchLicenses(licenses({}))).rejects.toThrow(/mirror:init/);
  });

  it('reports not ready, no data time, no service codes, and classifies from the table alone', async () => {
    const { service } = await coldService();
    expect(await service.ready()).toBe(false);
    expect(await service.dataAsOf()).toBeUndefined();
    expect(await service.serviceCodes()).toBeUndefined();
    expect(await service.classifyRadioService('CD')).toBe('not_indexed');
    expect(await service.classifyRadioService('ZQ')).toBe('unknown');
  });

  it('reports coverage status none with every group unindexed', async () => {
    const { service } = await coldService();
    expect(await service.coverage()).toEqual({
      index: { ready: false, status: 'none' },
      groups: SERVICE_GROUPS.map((group) => ({ group, indexed: false })),
      redactIndividuals: true,
    });
  });

  it('reports building while a live process holds the ingest lock', async () => {
    const { mirror, service } = await coldService();
    await writeFile(
      join(mirror.mirrorDir, LOCK_FILE),
      JSON.stringify({ pid: process.pid, mode: 'init', startedAt: '2026-09-29T20:00:00Z' }),
    );
    expect((await service.coverage()).index).toEqual({ ready: false, status: 'building' });
  });

  it("reports a failed build's error when no build is running", async () => {
    const { mirror, service } = await coldService();
    const ingester = fixtureIngester(mirror, {
      client: new FakeIngestClient().withWeekly(['paging']),
      groups: ['paging'],
      openArchive: () => Promise.reject(new Error('Disk read failed\nwhile opening the snapshot.')),
    });
    await expect(ingester.rebuild()).rejects.toThrow('Disk read failed');
    expect((await service.coverage()).index).toEqual({
      ready: false,
      status: 'none',
      error: 'Disk read failed\nwhile opening the snapshot.',
    });
    expect(await service.ready()).toBe(false);
  });

  it('reports a dangling pointer in coverage and recovers once a generation is published', async () => {
    const { mirror, service } = await coldService();
    await writePointer(mirror.mirrorDir, {
      file: 'fcc-uls-20260101T000000Z.db',
      publishedAt: '2026-01-01T00:00:00Z',
    });
    const message =
      'current.json names a generation file that is missing from the mirror directory; run mirror:init to rebuild the index.';
    expect(await service.ready()).toBe(false);
    expect((await service.coverage()).index).toEqual({
      ready: false,
      status: 'none',
      error: message,
    });
    await expect(service.searchLicenses(licenses({}))).rejects.toMatchObject({
      ...notReady,
      message,
    });

    await fixtureIngester(mirror, {
      client: new FakeIngestClient().withWeekly(['paging']),
      groups: ['paging'],
    }).rebuild();
    expect(await service.ready()).toBe(true);
    expect((await service.coverage()).index.error).toBeUndefined();
  });

  it('serves no generation built before schema 4, reports why, and serves the rebuilt one', async () => {
    const { mirror, service } = await coldService();
    const ingester = fixtureIngester(mirror, {
      client: new FakeIngestClient().withWeekly(['paging']),
      groups: ['paging'],
    });
    const first = await ingester.rebuild();
    const store = createUlsStore(join(mirror.mirrorDir, first.generation));
    try {
      (await store.raw()).exec('UPDATE schema_version SET version = 3');
    } finally {
      await store.close();
    }

    const message =
      'The published index was built by an earlier version of this server and must be rebuilt before it is served; run mirror:init to rebuild it.';
    expect(await service.ready()).toBe(false);
    expect(await service.dataAsOf()).toBeUndefined();
    expect((await service.coverage()).index).toEqual({
      ready: false,
      status: 'none',
      error: message,
    });
    await expect(service.searchLicenses(licenses({}))).rejects.toMatchObject({
      ...notReady,
      message,
    });

    await expect(ingester.refresh()).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'rebuild_required' },
    });
    const rebuilt = await ingester.rebuild();
    expect(rebuilt).toMatchObject({
      status: 'rebuilt',
      generation: `${first.generation.slice(0, -3)}-2.db`,
    });
    expect(await service.ready()).toBe(true);
    expect((await service.coverage()).index.error).toBeUndefined();
    expect(await ingester.rebuild()).toMatchObject({ status: 'skipped' });
  });

  it('serves a schema 4 generation once it has added the market-code index in place', async () => {
    const { mirror, service } = await coldService();
    const { generation } = await fixtureIngester(mirror, {
      client: new FakeIngestClient().set('complete/l_paging.zip', MARKET_CODES_WEEKLY),
      groups: ['paging'],
    }).rebuild();
    const path = join(mirror.mirrorDir, generation);
    const v4 = createUlsStore(path);
    try {
      // The schema 4 layout: no market-code index, stamped version 4.
      (await v4.raw()).exec(
        'DROP INDEX licenses_market_code; UPDATE schema_version SET version = 4;',
      );
    } finally {
      await v4.close();
    }

    expect(await service.ready()).toBe(true);
    expect(
      usis(page(await service.searchLicenses(licenses({ marketCode: 'PEA016' }))).rows),
    ).toEqual(['8003', '8004', '8006']);
    const upgraded = createUlsStore(path);
    try {
      const db = await upgraded.raw();
      expect(db.prepare<{ version: number }>('SELECT version FROM schema_version').get()).toEqual({
        version: 8,
      });
      expect(
        db.prepare('SELECT 1 FROM meta WHERE key = ?').get(META_KEYS.rebuildRequired),
      ).toBeFalsy();
      const plan = db
        .prepare<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT usi FROM licenses WHERE market_code = 'PEA016'",
        )
        .all()
        .map((row) => row.detail);
      expect(plan.join(' ')).toContain('licenses_market_code');
    } finally {
      await upgraded.close();
    }
  });

  it('reports a malformed pointer without its path, logs the path once, and recovers once mirror:init republishes', async () => {
    const { mirror, service } = await coldService();
    const pointerPath = join(mirror.mirrorDir, POINTER_FILE);
    await writeFile(pointerPath, '{"file": 42');
    const message =
      'current.json is not a valid generation pointer; rerun mirror:init to republish it.';
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    try {
      expect(await service.ready()).toBe(false);
      expect(await service.dataAsOf()).toBeUndefined();
      expect(await service.serviceCodes()).toBeUndefined();
      expect((await service.coverage()).index).toEqual({
        ready: false,
        status: 'none',
        error: message,
      });
      await expect(service.searchLicenses(licenses({}))).rejects.toMatchObject({
        ...notReady,
        message,
      });
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[1]).toMatchObject({ extra: { pointerPath } });
    } finally {
      warning.mockRestore();
    }

    await fixtureIngester(mirror, {
      client: new FakeIngestClient().withWeekly(['paging']),
      groups: ['paging'],
    }).rebuild();
    expect(await service.ready()).toBe(true);
    expect((await service.coverage()).index.error).toBeUndefined();
  });

  /**
   * A failure reading the index reaches callers as a path-free `ServiceUnavailable` with no
   * `data` path and no `cause`; the
   * operator log keeps the original error, path included.
   */
  function expectPathFree(mirror: TempMirror, failure: unknown, logged: string) {
    expect(failure).toBeInstanceOf(McpError);
    const error = failure as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/^The local ULS index could not be read: /);
    expect(error.message).not.toContain(mirror.mirrorDir);
    expect(JSON.stringify(error.data ?? {})).not.toContain(mirror.mirrorDir);
    expect(error.cause).toBeUndefined();
    const errorLog = vi.mocked(logger.error);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [message, original, context] = errorLog.mock.calls[0] ?? [];
    expect(message).toBe('Could not read the published ULS index generation.');
    expect(original).toBeInstanceOf(Error);
    expect((original as Error).message).toContain(logged);
    expect(context).toMatchObject({ extra: { mirrorDir: mirror.mirrorDir } });
  }

  it.skipIf(process.getuid?.() === 0)(
    'fails path-free, logging the full error, when current.json cannot be read',
    async () => {
      const { mirror, service } = await coldService();
      const pointerPath = join(mirror.mirrorDir, POINTER_FILE);
      await writePointer(mirror.mirrorDir, {
        file: FIXTURE_GENERATION,
        publishedAt: '2026-09-29T20:00:00Z',
      });
      await chmod(pointerPath, 0o000);
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      try {
        const failure = await service.searchLicenses(licenses({})).catch((err: unknown) => err);
        expectPathFree(mirror, failure, pointerPath);
        expect((failure as Error).message).toBe(
          "The local ULS index could not be read: EACCES: permission denied, open 'current.json'",
        );
      } finally {
        vi.mocked(logger.error).mockRestore();
        await chmod(pointerPath, 0o644);
      }
    },
  );

  it('fails path-free, logging the full error, when the published generation cannot be opened', async () => {
    const { mirror, service } = await coldService();
    // A directory where the generation file should be: the store's open fails, naming the file.
    const generationPath = join(mirror.mirrorDir, FIXTURE_GENERATION);
    await mkdir(generationPath);
    await writePointer(mirror.mirrorDir, {
      file: FIXTURE_GENERATION,
      publishedAt: '2026-09-29T20:00:00Z',
    });
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const failure = await service.coverage().catch((err: unknown) => err);
      expectPathFree(mirror, failure, FIXTURE_GENERATION);
      expect((failure as Error).message).toBe(
        `The local ULS index could not be read: Failed to open mirror store "${FIXTURE_GENERATION}".`,
      );
    } finally {
      vi.mocked(logger.error).mockRestore();
    }
  });

  it('keeps the mirror directory path out of a stored build error', async () => {
    const { mirror, service } = await coldService();
    const stored = `Truncated ZIP archive (${join(mirror.mirrorDir, 'tmp', 'l_paging.zip')}); scandir '${mirror.mirrorDir}'`;
    const ingester = fixtureIngester(mirror, {
      client: new FakeIngestClient().withWeekly(['paging']),
      groups: ['paging'],
      openArchive: () => Promise.reject(new Error(stored)),
    });
    // The operator running mirror:init still sees the full path.
    await expect(ingester.rebuild()).rejects.toThrow(stored);
    expect((await service.coverage()).index).toEqual({
      ready: false,
      status: 'none',
      error: `Truncated ZIP archive (${join('tmp', 'l_paging.zip')}); scandir 'the mirror directory'`,
    });
  });
});

describe('readiness, coverage, and service codes', () => {
  it('is ready with the newest applied file time as dataAsOf', async () => {
    expect(await on.ready()).toBe(true);
    expect(await on.dataAsOf()).toBe('2026-09-27T13:44:10Z');
  });

  it('reports coverage per group', async () => {
    const coverage = await on.coverage();
    expect(coverage.index).toEqual({
      ready: true,
      status: 'ready',
      generation: FIXTURE_GENERATION,
      lastFullBuild: '2026-09-29T20:00:00Z',
      dataAsOf: '2026-09-27T13:44:10Z',
    });
    expect(coverage.redactIndividuals).toBe(true);
    expect((await off.coverage()).redactIndividuals).toBe(false);
    const indexed = coverage.groups.filter((group) => group.indexed);
    expect(indexed).toEqual([
      {
        group: 'paging',
        indexed: true,
        records: 8,
        sites: 7,
        frequencies: 10,
        snapshotCreated: '2026-09-27T13:38:53Z',
      },
      {
        group: 'mdsitfs',
        indexed: true,
        records: 8,
        sites: 3,
        frequencies: 3,
        snapshotCreated: '2026-09-27T13:40:45Z',
      },
      {
        group: 'amat',
        indexed: true,
        records: 3,
        sites: 0,
        frequencies: 0,
        snapshotCreated: '2026-09-27T13:44:10Z',
      },
    ]);
    expect(coverage.groups).toHaveLength(SERVICE_GROUPS.length);
  });

  it('keeps the mirror directory path out of a failed refresh error on a ready index', async () => {
    const { mirror, service } = await coldService();
    const client = new FakeIngestClient().withWeekly(['paging']);
    await fixtureIngester(mirror, { client, groups: ['paging'] }).rebuild();
    client.withDaily({ 'l_pg_mon.zip': DAILY_PG_MON });
    const stored = `Not a ZIP archive (${join(mirror.mirrorDir, 'tmp', 'l_pg_mon.zip')})`;
    await expect(
      fixtureIngester(mirror, {
        client,
        groups: ['paging'],
        openArchive: () => Promise.reject(new Error(stored)),
      }).refresh(),
    ).rejects.toThrow(stored);
    expect((await service.coverage()).index).toMatchObject({
      ready: true,
      status: 'ready',
      error: `Not a ZIP archive (${join('tmp', 'l_pg_mon.zip')})`,
    });
  });

  it('lists the indexed service codes with group and record count', async () => {
    expect(Object.fromEntries((await on.serviceCodes()) ?? [])).toEqual({
      BR: { group: 'mdsitfs', records: 6 },
      CD: { group: 'paging', records: 7 },
      ED: { group: 'mdsitfs', records: 2 },
      HA: { group: 'amat', records: 3 },
      ZQ: { group: 'paging', records: 1 },
    });
  });

  it.each([
    ['CD', 'indexed'],
    ['ZQ', 'indexed'],
    ['CL', 'not_indexed'],
    ['Q9', 'unknown'],
  ])('classifies %s as %s', async (code, expected) => {
    expect(await on.classifyRadioService(code)).toBe(expected);
  });
});

describe('searchLicenses', () => {
  it('finds by callsign, every record sharing it, in callsign then USI order', async () => {
    const result = page(await on.searchLicenses(licenses({ callsign: 'KZZ901' })));
    expect(usis(result.rows)).toEqual(['1001', '1005']);
    expect(result.total).toBe(2);
    expect(result.nextCursor).toBeUndefined();
    expect(
      usis(page(await on.searchLicenses(licenses({ callsign: 'KZZ901', status: 'A' }))).rows),
    ).toEqual(['1001']);
  });

  it('returns the summary fields of a record', async () => {
    const [row] = page(await on.searchLicenses(licenses({ callsign: 'KZZ901', status: 'A' }))).rows;
    expect(row).toEqual({
      usi: '1001',
      callsign: 'KZZ901',
      isLease: false,
      licenseStatus: 'A',
      statusLabel: 'Active',
      radioServiceCode: 'CD',
      radioServiceLabel: 'Paging and Radiotelephone',
      serviceGroup: 'paging',
      licenseeName: 'Example Paging Co',
      licenseeRedacted: false,
      frn: '0001234567',
      applicantType: 'C',
      licenseeCity: 'SEATTLE',
      licenseeState: 'WA',
      grantDate: '2021-03-01',
      expiredDate: '2031-03-01',
      lastActionDate: '2021-03-02',
      locationCount: 2,
      frequencyCount: 4,
    } satisfies LicenseSummary);
  });

  it('counts only showable frequency rows, as get_license does', async () => {
    const [row] = page(await on.searchLicenses(licenses({ callsign: 'KZZ909' }))).rows;
    expect(row).toMatchObject({ usi: '1009', frequencyCount: 1 });
  });

  it('filters by FRN, radio service, status, and licensee state', async () => {
    expect(usis(page(await on.searchLicenses(licenses({ frn: '0001234567' }))).rows)).toEqual([
      '1001',
      '1005',
    ]);
    const unlabeled = page(await on.searchLicenses(licenses({ radioService: 'ZQ', status: 'A' })));
    expect(unlabeled.rows.map((row) => [row.usi, row.radioServiceLabel])).toEqual([['1008', 'ZQ']]);
    // NULL callsigns sort first in callsign order.
    expect(usis(page(await on.searchLicenses(licenses({ status: 'E' }))).rows)).toEqual([
      '2007',
      '2008',
      '2003',
      '1005',
    ]);
    expect(usis(page(await on.searchLicenses(licenses({ state: 'WA' }))).rows)).toEqual([
      '1001',
      '1005',
      '1002',
      '1003',
      '1008',
    ]);
    const none = page(await on.searchLicenses(licenses({ state: 'TX' })));
    expect(none).toEqual({ ok: true, rows: [], total: 0 });
  });

  it('withholds an individual licensee name and city only while redaction is on', async () => {
    const [redacted] = page(await on.searchLicenses(licenses({ callsign: 'KZZ903' }))).rows;
    expect(redacted).toMatchObject({ usi: '1003', licenseeName: null, licenseeRedacted: true });
    expect(redacted).not.toHaveProperty('licenseeCity');
    expect(redacted?.licenseeState).toBe('WA');
    const [shown] = page(await off.searchLicenses(licenses({ callsign: 'KZZ903' }))).rows;
    expect(shown).toMatchObject({
      licenseeName: 'Pat Q Example',
      licenseeRedacted: false,
      licenseeCity: 'SPOKANE',
    });
  });

  it('matches name prefixes and requires every word', async () => {
    expect(
      usis(page(await on.searchLicenses(licenses({ licensee: 'exam pag' }))).rows).sort(),
    ).toEqual(['1001', '1005']);
    expect(usis(page(await on.searchLicenses(licenses({ licensee: 'tri paging' }))).rows)).toEqual([
      '1006',
    ]);
    expect(page(await on.searchLicenses(licenses({ licensee: 'example tri' }))).total).toBe(0);
  });

  it('neutralizes FTS operators in the name', async () => {
    expect(
      usis(page(await on.searchLicenses(licenses({ licensee: '"tri-city*" (paging) ^' }))).rows),
    ).toEqual(['1006']);
    expect(page(await on.searchLicenses(licenses({ licensee: 'example NOT paging' }))).total).toBe(
      0,
    );
    expect(await on.searchLicenses(licenses({ licensee: '*:^"()' }))).toEqual({
      ok: true,
      rows: [],
      total: 0,
    });
  });

  it('excludes individuals from name search while redaction is on', async () => {
    const redacted = page(await on.searchLicenses(licenses({ licensee: 'example' })));
    expect(usis(redacted.rows).sort()).toEqual(['1001', '1005']);
    expect(redacted.total).toBe(2);
    const open = page(await off.searchLicenses(licenses({ licensee: 'example' })));
    expect(usis(open.rows).sort()).toEqual(['1001', '1003', '1005', '3001', '3003']);
    expect(open.total).toBe(5);
  });

  it('combines a name search with filters', async () => {
    const result = page(
      await off.searchLicenses(licenses({ licensee: 'example', status: 'A', state: 'CO' })),
    );
    expect(usis(result.rows).sort()).toEqual(['3001', '3003']);
  });

  it('pages in callsign order without repeating the blank-callsign records', async () => {
    const { pages, rows, total } = await allPages((cursor) =>
      on.searchLicenses(licenses({ status: 'E', limit: 1, cursor })),
    );
    expect(pages).toBe(4);
    expect(total).toBe(4);
    expect(usis(rows)).toEqual(['2007', '2008', '2003', '1005']);
  });

  it('pages a full callsign-ordered scan with no duplicates', async () => {
    const { rows, total } = await allPages((cursor) =>
      on.searchLicenses(licenses({ limit: 3, cursor })),
    );
    expect(total).toBe(19);
    expect(new Set(usis(rows)).size).toBe(19);
  });

  it('pages a name search in rank order with no duplicates', async () => {
    const { pages, rows, total } = await allPages((cursor) =>
      off.searchLicenses(licenses({ licensee: 'example', limit: 2, cursor })),
    );
    expect(pages).toBe(3);
    expect(total).toBe(5);
    expect(usis(rows).sort()).toEqual(['1001', '1003', '1005', '3001', '3003']);
  });

  it.each([
    ['a cursor from another generation', forgeCursor('20990101T000000Z', 'c', null, 1)],
    ['a cursor of another query shape', forgeCursor('20260927T133855Z', 'r', 1, 1)],
    ['a cursor with the wrong key shape', forgeCursor('20260927T133855Z', 'c', 'KZZ901')],
    ['bytes that do not decode', 'not-a-cursor'],
  ])('rejects %s as invalid_cursor', async (_label, cursor) => {
    expect(await on.searchLicenses(licenses({ cursor }))).toEqual({
      ok: false,
      reason: 'invalid_cursor',
    });
  });

  it('rejects a callsign-order cursor on a name search', async () => {
    const first = page(await on.searchLicenses(licenses({ limit: 1 })));
    expect(first.nextCursor).toBeDefined();
    expect(
      await on.searchLicenses(licenses({ licensee: 'example', cursor: first.nextCursor })),
    ).toEqual({ ok: false, reason: 'invalid_cursor' });
  });
});

describe('searchLicenses cursors across a daily refresh', () => {
  let fixture: FixtureIndex;
  beforeAll(async () => {
    fixture = await buildFixtureIndex({ groups: ['paging'] });
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  it('fails a rank-order cursor minted before the refresh and keeps a callsign-order one', async () => {
    const service = fixture.service({ redactIndividuals: false });
    const ranked = page(await service.searchLicenses(licenses({ licensee: 'example', limit: 1 })));
    const ordered = page(await service.searchLicenses(licenses({ limit: 1 })));
    expect(ranked.nextCursor).toBeDefined();
    expect(ordered.nextCursor).toBeDefined();
    expect(
      (
        await service.searchLicenses(
          licenses({ licensee: 'example', limit: 1, cursor: ranked.nextCursor }),
        )
      ).ok,
    ).toBe(true);

    fixture.client.withDaily({ 'l_pg_mon.zip': DAILY_PG_MON });
    await fixture.ingester.refresh();

    expect(
      await service.searchLicenses(
        licenses({ licensee: 'example', limit: 1, cursor: ranked.nextCursor }),
      ),
    ).toEqual({ ok: false, reason: 'invalid_cursor' });
    expect(
      (await service.searchLicenses(licenses({ limit: 1, cursor: ordered.nextCursor }))).ok,
    ).toBe(true);
    const fresh = page(await service.searchLicenses(licenses({ licensee: 'example', limit: 1 })));
    expect(
      (
        await service.searchLicenses(
          licenses({ licensee: 'example', limit: 1, cursor: fresh.nextCursor }),
        )
      ).ok,
    ).toBe(true);
  });
});

describe('getLicense', () => {
  it('returns the full record by USI, with the other record sharing its callsign', async () => {
    const result = await on.getLicense({ usi: '1001', maxFrequencies: 100 });
    if (!result.found) throw new Error('expected a record');
    expect(result.license).toEqual({
      usi: '1001',
      callsign: 'KZZ901',
      isLease: false,
      licenseStatus: 'A',
      statusLabel: 'Active',
      radioServiceCode: 'CD',
      radioServiceLabel: 'Paging and Radiotelephone',
      serviceGroup: 'paging',
      grantDate: '2021-03-01',
      effectiveDate: '2021-03-01',
      expiredDate: '2031-03-01',
      lastActionDate: '2021-03-02',
      licensee: {
        name: 'Example Paging Co',
        redacted: false,
        role: 'licensee',
        frn: '0001234567',
        applicantType: 'C',
        city: 'SEATTLE',
        state: 'WA',
      },
      leasedFrom: [],
      leases: [],
      leaseCount: 0,
    });
    expect(result.otherCallsignRecords).toEqual([{ usi: '1005', licenseStatus: 'E' }]);
    expect(result).toMatchObject({
      technicalRetained: true,
      frequencyTotal: 4,
      frequenciesShown: 4,
    });

    const [site, tacoma] = result.locations;
    expect(site).toMatchObject({
      locationNumber: 1,
      locationTypeCode: 'F',
      locationTypeLabel: 'Fixed',
      locationClassCode: 'T',
      groundElevationM: 50.3,
      supportHeightM: 30,
      overallHeightM: 45.5,
      structureType: 'TOWER',
      asrNumber: '1012345',
      address: '1 Tower Rd',
      city: 'SEATTLE',
      county: 'KING',
      state: 'WA',
      stateFromCoordinates: false,
      name: 'Seattle Hill',
    });
    expect(site?.latitude).toBeCloseTo(SEATTLE_SITE.latitude, 9);
    expect(site?.longitude).toBeCloseTo(SEATTLE_SITE.longitude, 9);
    expect(site?.antennas).toHaveLength(1);
    const antenna = site?.antennas[0];
    expect(antenna).toMatchObject({
      antennaNumber: 1,
      antennaTypeCode: 'T',
      heightToTipM: 45,
      heightToCenterM: 40,
      haatM: 120,
      azimuthDeg: 0,
      gainDbi: 6.1,
      beamwidthDeg: 360,
      polarization: 'V',
      make: 'ANTCO',
      model: 'A-100',
    });
    expect(antenna?.frequencies.map((f) => ({ ...f, emissions: [...f.emissions].sort() }))).toEqual(
      [
        {
          frequencyMhz: 152.24,
          bandwidthMhz: 0.016,
          stationClass: 'FB2',
          powerOutputW: 100,
          erpW: 250,
          transmitterMake: 'TXCO',
          transmitterModel: 'T1',
          emissions: ['11K2F3E', '16K0F3E'],
        },
        {
          frequencyMhz: 152.24,
          bandwidthMhz: 0.0112,
          stationClass: 'FB2',
          erpW: 300,
          transmitterModel: 'T2',
          emissions: ['11K2F3E'],
        },
        { frequencyMhz: 454.1, stationClass: 'FB', erpW: 50, emissions: [] },
      ],
    );
    expect(tacoma).toMatchObject({ locationNumber: 2, city: 'TACOMA', state: 'WA' });
    expect(tacoma?.stateFromCoordinates).toBe(true);
    expect(tacoma?.antennas[0]?.frequencies.map((f) => f.frequencyMhz)).toEqual([931.0125]);
  });

  it('resolves a shared callsign to the active record', async () => {
    const result = await on.getLicense({ callsign: 'KZZ901', maxFrequencies: 10 });
    expect(result.found && result.license.usi).toBe('1001');
    expect(result.found && result.otherCallsignRecords).toEqual([
      { usi: '1005', licenseStatus: 'E' },
    ]);
  });

  it('offers up to five callsign-prefix candidates on a miss', async () => {
    expect(await on.getLicense({ callsign: 'KZZ90', maxFrequencies: 10 })).toEqual({
      found: false,
      candidates: [
        { callsign: 'KZZ901', usi: '1001', licenseStatus: 'A' },
        { callsign: 'KZZ901', usi: '1005', licenseStatus: 'E' },
        { callsign: 'KZZ902', usi: '1002', licenseStatus: 'C' },
        { callsign: 'KZZ903', usi: '1003', licenseStatus: 'A' },
        { callsign: 'KZZ906', usi: '1006', licenseStatus: 'X' },
      ],
    });
    expect(await on.getLicense({ callsign: 'QQQ123', maxFrequencies: 10 })).toEqual({
      found: false,
      candidates: [],
    });
    expect(await on.getLicense({ usi: '424242', maxFrequencies: 10 })).toEqual({
      found: false,
      candidates: [],
    });
  });

  it('links a parent to its leases and each lease to its parent, including a missing parent', async () => {
    const parent = await on.getLicense({ usi: '2001', maxFrequencies: 100 });
    if (!parent.found) throw new Error('expected a record');
    expect(parent.license).toMatchObject({
      isLease: false,
      licensee: { name: 'Sample Broadband Inc', role: 'licensee' },
      leasedFrom: [],
      leases: [
        { callsign: 'L000000001', usi: '2002', licenseStatus: 'A' },
        { callsign: 'L000000002', usi: '2004', licenseStatus: 'A' },
      ],
      leaseCount: 2,
    });

    const lease = await on.getLicense({ callsign: 'L000000001', maxFrequencies: 100 });
    if (!lease.found) throw new Error('expected a record');
    expect(lease.license).toMatchObject({
      usi: '2002',
      isLease: true,
      licensee: { name: 'Leaseholder Wireless LLC', role: 'lessee' },
      leasedFrom: [{ callsign: 'KZZ801', usi: '2001' }],
      leases: [],
      leaseCount: 0,
    });

    const orphan = await on.getLicense({ usi: '2006', maxFrequencies: 100 });
    expect(orphan.found && orphan.license.leasedFrom).toEqual([
      { callsign: 'KZZ999', usi: '9999' },
    ]);
  });

  it('returns market blocks in frequency order, a blank partition included', async () => {
    const result = await on.getLicense({ usi: '2001', maxFrequencies: 100 });
    expect(result.found && result.license.market).toEqual({
      marketCode: 'BTA138',
      marketName: 'Fargo-Moorhead, ND-MN',
      channelBlock: 'A1',
      blocks: [
        { lowMhz: 2496, highMhz: 2502, partitionAreaIds: [1] },
        { lowMhz: 2502, highMhz: 2508 },
      ],
    });
    const nationwide = await on.getLicense({ usi: '2003', maxFrequencies: 100 });
    expect(nationwide.found && nationwide.license.market).toEqual({
      marketCode: 'P35',
      marketName: 'P35 GSA',
      blocks: [],
    });
  });

  it('withholds the trustee name on every license and individual names only while redacting', async () => {
    const club = await on.getLicense({ callsign: 'KZ1CLB', maxFrequencies: 10 });
    if (!club.found) throw new Error('expected a record');
    expect(club.license.licensee).toMatchObject({ name: 'Sample Radio Club', redacted: false });
    expect(club.license.amateur).toEqual({ trusteeCallsign: 'KZ1AAA', trusteeName: null });
    const clubOpen = await off.getLicense({ callsign: 'KZ1CLB', maxFrequencies: 10 });
    expect(clubOpen.found && clubOpen.license.amateur).toEqual({
      trusteeCallsign: 'KZ1AAA',
      trusteeName: 'Trustee Person Example',
    });

    const individual = await on.getLicense({ callsign: 'KZ1AAA', maxFrequencies: 10 });
    if (!individual.found) throw new Error('expected a record');
    expect(individual.license.licensee).toEqual({
      name: null,
      redacted: true,
      role: 'licensee',
      state: 'CO',
    });
    expect(individual.license.amateur).toEqual({
      operatorClass: 'E',
      operatorClassLabel: 'Amateur Extra',
      previousCallsign: 'KZ1ZZZ',
    });
    const individualOpen = await off.getLicense({ callsign: 'KZ1AAA', maxFrequencies: 10 });
    expect(individualOpen.found && individualOpen.license.licensee).toMatchObject({
      name: 'Alex Amateur Example',
      redacted: false,
      city: 'DENVER',
    });
  });

  it("omits an individual's site address and site name only while redacting", async () => {
    const redacted = await on.getLicense({ callsign: 'KZZ903', maxFrequencies: 10 });
    if (!redacted.found) throw new Error('expected a record');
    expect(redacted.locations[0]).not.toHaveProperty('address');
    expect(redacted.locations[0]).not.toHaveProperty('name');
    expect(redacted.locations[0]).toMatchObject({
      city: 'SPOKANE',
      state: 'WA',
      stateFromCoordinates: false,
    });
    expect(redacted.license.licensee).toMatchObject({ name: null, redacted: true });
    expect(JSON.stringify(redacted)).not.toContain('Pat Q Example');
    const open = await off.getLicense({ callsign: 'KZZ903', maxFrequencies: 10 });
    expect(open.found && open.locations[0]).toMatchObject({
      address: '42 Private Lane',
      name: 'Pat Q Example',
    });
  });

  it("returns an organization's site names while redacting", async () => {
    const result = await on.getLicense({ callsign: 'KZZ901', maxFrequencies: 10 });
    expect(result.found && result.locations[0]?.name).toBe('Seattle Hill');
  });

  it('caps frequency rows by dropping the last location first', async () => {
    const capped = await on.getLicense({ usi: '1001', maxFrequencies: 2 });
    if (!capped.found) throw new Error('expected a record');
    expect(capped.frequencyTotal).toBe(4);
    expect(capped.frequenciesShown).toBe(2);
    const shownPerLocation = capped.locations.map(
      (location) => location.antennas.flatMap((antenna) => antenna.frequencies).length,
    );
    expect(shownPerLocation).toEqual([2, 0]);
    const three = await on.getLicense({ usi: '1001', maxFrequencies: 3 });
    expect(
      three.found && three.locations.map((l) => l.antennas.flatMap((a) => a.frequencies).length),
    ).toEqual([3, 0]);
  });

  it('keeps no technical data for a non-live record', async () => {
    const result = await on.getLicense({ usi: '1002', maxFrequencies: 100 });
    expect(result).toMatchObject({
      found: true,
      technicalRetained: false,
      locations: [],
      frequencyTotal: 0,
      frequenciesShown: 0,
      license: {
        licenseStatus: 'C',
        statusLabel: 'Canceled',
        cancellationDate: '2020-06-30',
      },
    });
  });

  it('keeps a CR in the licensee name verbatim and the raw DMS of invalid coordinates', async () => {
    const result = await on.getLicense({ callsign: 'KZZ907', maxFrequencies: 100 });
    if (!result.found) throw new Error('expected a record');
    expect(result.license.licensee.name).toBe('Carriage\rReturn Paging');
    expect(result.license.licenseStatus).toBe('L');
    expect(result.technicalRetained).toBe(true);
    const [site] = result.locations;
    expect(site).not.toHaveProperty('latitude');
    expect(site?.coordinatesDms).toMatch(/61/);
    expect(site?.state).toBe('ID');
  });

  it('counts only showable frequency rows: a blank frequency is neither shown nor counted', async () => {
    const result = await on.getLicense({ usi: '1009', maxFrequencies: 100 });
    if (!result.found) throw new Error('expected a record');
    expect(result.frequencyTotal).toBe(1);
    expect(result.frequenciesShown).toBe(1);
    expect(result.locations[0]?.antennas[0]?.frequencies).toEqual([
      { frequencyMhz: 929.5, stationClass: 'FB', emissions: ['XYZ'] },
    ]);
    expect(result.locations[0]).not.toHaveProperty('state');
  });
});

describe('getLicense from a location number', () => {
  let gapped: FixtureIndex;
  let service: UlsIndexService;
  /** Sites at 0–59 and 70–129, and 135 filed on antenna and frequency rows alone. */
  const numbers = [
    ...Array.from({ length: 60 }, (_, i) => i),
    ...Array.from({ length: 60 }, (_, i) => i + 70),
  ];

  beforeAll(async () => {
    gapped = await buildFixtureIndex({
      weekly: {
        paging: sprawlingPagingWeekly({
          locations: numbers,
          siteless: [135],
          sitesAtFirst: 1,
          antennasPerLocation: 2,
          leases: 0,
        }),
      },
    });
    service = gapped.service();
  });
  afterAll(async () => {
    await gapped?.dispose();
  });

  const byNumber = (locationNumber: number) =>
    service.getLicense({ usi: '7001', maxFrequencies: 100, locationNumber });
  const byOffset = (locationOffset: number) =>
    service.getLicense({ usi: '7001', maxFrequencies: 100, locationOffset });

  it.each([
    [0, 0],
    [55, 55],
    [70, 60],
    [110, 100],
    [135, 120],
  ])('starts at filed location %i as location_offset %i does', async (number, offset) => {
    const result = await byNumber(number);
    expect(result).toEqual(await byOffset(offset));
    if (!result.found) throw new Error('Expected KZZ701.');
    expect(result.locations[0]?.locationNumber).toBe(number);
    expect(result).toMatchObject({ locationOffset: offset, lastLocationNumber: 135 });
  });

  it.each([
    [60, 60, 70],
    [131, 120, 135],
  ])(
    'starts unfiled location %i at the next filed one, offset %i',
    async (number, offset, next) => {
      const result = await byNumber(number);
      expect(result).toEqual(await byOffset(offset));
      expect(result.found && result.locations[0]?.locationNumber).toBe(next);
    },
  );

  it('lists nothing past the last filed location', async () => {
    const result = await byNumber(136);
    expect(result).toMatchObject({
      found: true,
      locations: [],
      locationOffset: 121,
      locationTotal: 121,
      lastLocationNumber: 135,
      frequenciesShown: 0,
      windowFrequencyTotal: 0,
    });
    expect(result).not.toHaveProperty('nextLocationOffset');
  });

  it('reports the offset it was given when it starts from one', async () => {
    expect(await byOffset(50)).toMatchObject({ locationOffset: 50, nextLocationOffset: 100 });
    const plain = await service.getLicense({ usi: '7001', maxFrequencies: 100 });
    expect(plain).toMatchObject({ locationOffset: 0, nextLocationOffset: 50 });
  });
});

/**
 * Every location window of a record, from offset 0 along `nextLocationOffset`: one
 * `[locationOffset, first number, last number, locations, sitesShown, nextLocationOffset]` row per
 * window, and a digest of each window's whole result without the two path counts, which must be 0
 * on a record that files no paths. The record must carry no `paths` anywhere.
 */
async function licenseWindows(service: UlsIndexService, usi: string, maxFrequencies: number) {
  const rows: (number | undefined)[][] = [];
  const digests: string[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const result = await service.getLicense({ usi, maxFrequencies, locationOffset: offset });
    if (!result.found) throw new Error(`Expected USI ${usi}.`);
    const { pathTotal, pathsShown, ...rest } = result as typeof result & {
      pathTotal?: number;
      pathsShown?: number;
    };
    expect(pathTotal ?? 0).toBe(0);
    expect(pathsShown ?? 0).toBe(0);
    const json = JSON.stringify(rest);
    expect(json).not.toContain('"paths"');
    digests.push(createHash('sha256').update(json).digest('hex').slice(0, 16));
    rows.push([
      result.locationOffset,
      result.locations[0]?.locationNumber,
      result.locations.at(-1)?.locationNumber,
      result.locations.length,
      result.sitesShown,
      result.nextLocationOffset,
    ]);
    offset = result.nextLocationOffset;
  }
  return { rows, digests };
}

describe('location windows of records that file no paths', () => {
  let sitesBound: FixtureIndex;
  let antennasBound: FixtureIndex;
  let micro: FixtureIndex;
  beforeAll(async () => {
    sitesBound = await buildFixtureIndex({
      groups: ['paging'],
      weekly: {
        paging: sprawlingPagingWeekly({
          locations: 60,
          sitesAtFirst: 3,
          antennasPerLocation: 1,
          leases: 0,
        }),
      },
    });
    antennasBound = await buildFixtureIndex({
      groups: ['paging'],
      weekly: {
        paging: sprawlingPagingWeekly({
          locations: 41,
          sitesAtFirst: 70,
          antennasPerLocation: 3,
          leases: 0,
        }),
      },
    });
    micro = await buildFixtureIndex({ groups: ['micro'] });
  });
  afterAll(async () => {
    await Promise.all([sitesBound?.dispose(), antennasBound?.dispose(), micro?.dispose()]);
  });

  it('lists every window of the fixture records as it did before paths', async () => {
    const store = createUlsStore(join(fixture.mirrorDir, fixture.generation));
    let all: string[];
    try {
      all = (await store.raw())
        .prepare<{ usi: number }>('SELECT usi FROM licenses ORDER BY usi')
        .all()
        .map((row) => String(row.usi));
    } finally {
      await store.close();
    }
    const seen: Record<string, unknown> = {};
    for (const usi of all) {
      seen[usi] = await licenseWindows(on, usi, 100);
      seen[`${usi}/off`] = await licenseWindows(off, usi, 2);
    }
    seen['sites/7001'] = await licenseWindows(sitesBound.service(), '7001', 100);
    seen['sites/7001/cap'] = await licenseWindows(sitesBound.service(), '7001', 30);
    seen['antennas/7001'] = await licenseWindows(antennasBound.service(), '7001', 100);
    seen['micro/9006'] = await licenseWindows(micro.service(), '9006', 100);
    seen['micro/9008'] = await licenseWindows(micro.service(), '9008', 100);
    expect(seen).toEqual(WINDOWS_BEFORE_PATHS);
  });
});

/**
 * The windows {@link licenseWindows} read from the code before paths were listed, on both
 * runtimes: every fixture record with redaction on (100 frequency rows) and off (2 rows), the
 * site-bound and antenna-bound sprawls (the first at 30 rows too), and the microwave fixture's
 * pathless live record KZZ925 and cancelled KZZ927.
 */
const WINDOWS_BEFORE_PATHS = {
  '1001': { rows: [[0, 1, 2, 2, 2, undefined]], digests: ['84fcfa47c06e392e'] },
  '1002': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['ba2586ae38da81f9'] },
  '1003': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['62ec9e7ec8d283bf'] },
  '1005': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['5550b518da8b2c52'] },
  '1006': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['c1296e5eb25f76fc'] },
  '1007': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['fd2a8be7ace0094a'] },
  '1008': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['6292dbae4f69bf0c'] },
  '1009': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['deede79fb91b2ae0'] },
  '2001': { rows: [[0, 1, 2, 2, 2, undefined]], digests: ['c5a6192bf207a695'] },
  '2002': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['82b094aae5683725'] },
  '2003': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['adb7229d6de4e218'] },
  '2004': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['53ea29390b7fc875'] },
  '2005': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['6f07c7df0e023a4a'] },
  '2006': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['de2979e8a7b9a89f'] },
  '2007': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['e8b0a6ec3688d452'] },
  '2008': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['323c16b3f750b13f'] },
  '3001': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['6b4b653c6b9633b2'] },
  '3002': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['36326d1dfa63509c'] },
  '3003': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['30ca50027fd2002b'] },
  '1001/off': { rows: [[0, 1, 2, 2, 2, undefined]], digests: ['a7083aa364943835'] },
  '1002/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['ba2586ae38da81f9'] },
  '1003/off': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['380397e7920856ee'] },
  '1005/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['5550b518da8b2c52'] },
  '1006/off': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['c1296e5eb25f76fc'] },
  '1007/off': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['fd2a8be7ace0094a'] },
  '1008/off': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['6292dbae4f69bf0c'] },
  '1009/off': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['deede79fb91b2ae0'] },
  '2001/off': { rows: [[0, 1, 2, 2, 2, undefined]], digests: ['c5a6192bf207a695'] },
  '2002/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['82b094aae5683725'] },
  '2003/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['adb7229d6de4e218'] },
  '2004/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['53ea29390b7fc875'] },
  '2005/off': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['6f07c7df0e023a4a'] },
  '2006/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['de2979e8a7b9a89f'] },
  '2007/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['e8b0a6ec3688d452'] },
  '2008/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['323c16b3f750b13f'] },
  '3001/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['815c8c4ba494539e'] },
  '3002/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['e093f645439f477d'] },
  '3003/off': { rows: [[0, undefined, undefined, 0, 0, undefined]], digests: ['a07d193167319ec8'] },
  'sites/7001': {
    rows: [
      [0, 1, 48, 48, 50, 48],
      [48, 49, 60, 12, 12, undefined],
    ],
    digests: ['1392e45f7c6fcaa4', '325493c77a4e1237'],
  },
  'sites/7001/cap': {
    rows: [
      [0, 1, 48, 48, 50, 48],
      [48, 49, 60, 12, 12, undefined],
    ],
    digests: ['7f2e8984e5315ab8', '325493c77a4e1237'],
  },
  'antennas/7001': {
    rows: [
      [0, 1, 1, 1, 70, 1],
      [1, 2, 34, 33, 33, 34],
      [34, 35, 41, 7, 7, undefined],
    ],
    digests: ['1b9361c09bf479c8', 'fe09fd14ead36cbb', 'a59d0bd2eda9f467'],
  },
  'micro/9006': { rows: [[0, 1, 1, 1, 1, undefined]], digests: ['a4cfe486c412f77d'] },
  'micro/9008': {
    rows: [[0, undefined, undefined, 0, 0, undefined]],
    digests: ['fb5f24a70c8e3e34'],
  },
};

/** A found `getLicense` result, or the test fails. */
function found(result: GetLicenseResult): Extract<GetLicenseResult, { found: true }> {
  if (!result.found) throw new Error('Expected a record.');
  return result;
}

/** The antenna entry numbered `antenna` at location `location` of a result's window. */
function antennaAt(result: GetLicenseResult, location: number, antenna: number) {
  return found(result)
    .locations.find((entry) => entry.locationNumber === location)
    ?.antennas.find((entry) => entry.antennaNumber === antenna);
}

/** `[location, antenna, path numbers]` for every antenna of a window that lists paths. */
const pathsByAntenna = (result: GetLicenseResult) =>
  found(result).locations.flatMap((location) =>
    location.antennas
      .filter((antenna) => antenna.paths)
      .map((antenna) => [
        location.locationNumber,
        antenna.antennaNumber,
        antenna.paths?.map((path) => path.pathNumber),
      ]),
  );

/** Coordinates of a microwave fixture site at `34-<minute>-0 N 119-<minute>-0 W`. */
const microSite = (minute: number) => ({
  latitude: dms(34, minute, 0),
  longitude: dms(119, minute, 0, true),
});

/** Every key a listed path or its receive end may carry: none is a name. */
const PATH_KEYS = new Set([
  'pathNumber',
  'pathType',
  'passiveReceiver',
  'receiverCallsign',
  'receive',
]);
const RECEIVE_KEYS = new Set([
  'locationNumber',
  'antennaNumber',
  'antennaFiled',
  'latitude',
  'longitude',
  'siteCount',
]);

/**
 * KZZ950 (USI 9101, MG): transmit locations 1–3, one antenna and frequency row each, filing 60,
 * 40, and 1 paths from antenna 1 (path numbers 1–101) to receive location 4 antenna 1. Four sites
 * and four antennas stay far under their budgets, so only the path budget can split the window:
 * 60 + 40 is exactly 100, and location 3's path would be the 101st.
 */
function pathBudgetWeekly(): FixtureFile {
  const usi = 9101;
  const site = (number: number) =>
    lo({
      usi,
      number,
      type: 'F',
      locationClass: number === 4 ? 'R' : 'T',
      lat: [34, number, 0, 'N'],
      lon: [119, number, 0, 'W'],
    });
  const zip = recordsZip('Sun Sep 27 09:39:09 EDT 2026', {
    HD: [hd({ usi, callsign: 'KZZ950', status: 'A', service: 'MG', grant: '01/01/2020' })],
    EN: [en({ usi, name: 'Path Budget Links Co', state: 'CA', applicantType: 'C' })],
    LO: [1, 2, 3, 4].map(site),
    AN: [1, 2, 3, 4].map((location) =>
      an({ usi, antenna: 1, location, type: location === 4 ? 'R' : 'T' }),
    ),
    FR: [1, 2, 3].map((location) =>
      fr({ usi, location, antenna: 1, seq: 1, stationClass: 'FXO', frequency: 6000 + location }),
    ),
    PA: [
      ...Array.from({ length: 60 }, (_, i) => [1, i + 1]),
      ...Array.from({ length: 40 }, (_, i) => [2, i + 61]),
      [3, 101],
    ].map(([txLocation = 0, path = 0]) =>
      pa({
        usi,
        path,
        txLocation,
        txAntenna: 1,
        rxLocation: 4,
        rxAntenna: 1,
        pathType: 'Fixed Point-to-Point',
        passive: 'N',
      }),
    ),
  });
  return {
    countsCreated: MICRO_WEEKLY.countsCreated,
    lastModified: MICRO_WEEKLY.lastModified,
    zip,
  };
}

describe('getLicense microwave paths', () => {
  let micro: FixtureIndex;
  let service: UlsIndexService;
  let open: UlsIndexService;
  beforeAll(async () => {
    micro = await buildFixtureIndex({ groups: ['micro'] });
    service = micro.service();
    open = micro.service({ redactIndividuals: false });
  });
  afterAll(async () => {
    await micro?.dispose();
  });
  const license = (
    usi: string,
    extra: Partial<{ locationOffset: number; locationNumber: number }> = {},
  ) => service.getLicense({ usi, maxFrequencies: 1000, ...extra } as GetLicenseParams);

  it('lists each path under its transmit antenna, with the receive site this license files', async () => {
    const result = found(await service.getLicense({ callsign: 'KZZ920', maxFrequencies: 100 }));
    expect(result).toMatchObject({ pathTotal: 10, pathsShown: 10, locationTotal: 7 });
    expect(result).not.toHaveProperty('pathCoverageIncomplete');
    expect(antennaAt(result, 1, 3)?.paths).toEqual([
      {
        pathNumber: 3,
        pathType: 'Fixed Point-to-Point',
        passiveReceiver: false,
        receiverCallsign: 'KZZ930',
        receive: { locationNumber: 2, antennaNumber: 1, ...microSite(22) },
      },
    ]);
    expect(
      found(result).locations[0]?.antennas.map((antenna) => [
        antenna.antennaNumber,
        antenna.frequencies.length,
        antenna.paths?.map((path) => [
          path.pathNumber,
          path.receive.locationNumber,
          path.receiverCallsign,
        ]),
      ]),
    ).toEqual([
      [3, 1, [[3, 2, 'KZZ930']]],
      [4, 1, [[4, 3, 'KZZ931']]],
      [5, 1, [[5, 4, undefined]]],
      [6, 1, [[6, 5, 'KZZ933']]],
      [7, 1, [[7, 6, undefined]]],
      [9, 1, [[9, 7, 'KZZ935']]],
      [10, 1, [[10, 2, undefined]]],
      [11, 1, [[11, 3, 'KZZ937']]],
      [15, 1, [[15, 4, undefined]]],
      [16, 1, [[16, 5, 'KZZ939']]],
    ]);
    // Receive antennas transmit nothing.
    const receivers = result.locations.slice(1).flatMap((location) => location.antennas);
    expect(receivers).toHaveLength(6);
    for (const antenna of receivers) expect(antenna).not.toHaveProperty('paths');
  });

  it('keeps unjoined endpoints as filed, duplicate path numbers in filing order, and bare transmit antennas', async () => {
    const result = found(await license('9002'));
    expect(result).toMatchObject({ pathTotal: 6, pathsShown: 6, locationTotal: 2 });
    expect(pathsByAntenna(result)).toEqual([
      [1, 1, [1, 2, 6]],
      [1, 2, [2]],
      [1, 8, [5]],
      [1, 9, [4]],
    ]);
    const receiveSite = microSite(31);
    expect(antennaAt(result, 1, 1)?.paths).toEqual([
      {
        pathNumber: 1,
        pathType: 'Fixed Point-to-Point',
        passiveReceiver: false,
        receive: { locationNumber: 3, antennaNumber: 2, antennaFiled: false, siteCount: 0 },
      },
      { pathNumber: 2, pathType: 'Area', receive: { locationNumber: 2, ...receiveSite } },
      {
        pathNumber: 6,
        pathType: 'Fixed Point-to-Point',
        passiveReceiver: false,
        receive: { locationNumber: 2, antennaNumber: 7, antennaFiled: false, ...receiveSite },
      },
    ]);
    expect(antennaAt(result, 1, 2)?.paths).toEqual([
      {
        pathNumber: 2,
        pathType: 'Fixed Point-to-Point',
        passiveReceiver: true,
        receiverCallsign: 'KZZ920',
        receive: { locationNumber: 2, antennaNumber: 1, ...receiveSite },
      },
    ]);
    // Antenna 8 files no AN or FR row: a bare entry carries its path.
    expect(antennaAt(result, 1, 8)).toEqual({
      antennaNumber: 8,
      frequencies: [],
      paths: [
        {
          pathNumber: 5,
          pathType: 'Fixed Point-to-Point',
          passiveReceiver: false,
          receive: { locationNumber: 2, antennaNumber: 1, ...receiveSite },
        },
      ],
    });
    // Antenna 9 files only a frequency row.
    expect(antennaAt(result, 1, 9)).toMatchObject({
      antennaNumber: 9,
      frequencies: [{ frequencyMhz: 6100 }],
      paths: [{ pathNumber: 4 }],
    });
    expect(found(result).locations[0]?.antennas.map((antenna) => antenna.antennaNumber)).toEqual([
      1, 2, 8, 9,
    ]);
  });

  it('gives a receive number filed at several sites its site count and no coordinates, and an invalid site neither', async () => {
    const result = found(await license('9003'));
    expect(antennaAt(result, 1, 1)?.paths).toEqual([
      {
        pathNumber: 17,
        pathType: 'Fixed Point-to-Point',
        passiveReceiver: false,
        receiverCallsign: 'KZZ931',
        receive: { locationNumber: 2, antennaNumber: 1, siteCount: 2 },
      },
      {
        pathNumber: 18,
        pathType: 'Fixed Point-to-Point',
        passiveReceiver: false,
        receive: { locationNumber: 3, antennaNumber: 1 },
      },
    ]);
  });

  it('pages paths spread over locations with the window, counting every path in pathTotal', async () => {
    const first = found(await license('9004'));
    expect(first).toMatchObject({ pathTotal: 120, pathsShown: 80, nextLocationOffset: 2 });
    expect(first.locations.map((location) => location.locationNumber)).toEqual([1, 2]);
    expect(pathsByAntenna(first)).toHaveLength(80);
    expect(antennaAt(first, 2, 40)?.paths?.map((path) => path.pathNumber)).toEqual([80]);
    const second = found(await license('9004', { locationOffset: 2 }));
    expect(second).toMatchObject({ pathTotal: 120, pathsShown: 40, locationOffset: 2 });
    expect(second).not.toHaveProperty('nextLocationOffset');
    expect(second.locations.map((location) => location.locationNumber)).toEqual([3, 10]);
    expect(antennaAt(second, 3, 1)?.paths?.map((path) => path.pathNumber)).toEqual([81]);
  });

  it('lists a location with more than 100 paths alone and whole', async () => {
    const first = found(await license('9005'));
    expect(first).toMatchObject({ pathTotal: 103, pathsShown: 103, nextLocationOffset: 1 });
    expect(first.locations.map((location) => location.locationNumber)).toEqual([1]);
    const listed = first.locations[0]?.antennas.flatMap((antenna) => antenna.paths ?? []);
    expect(listed?.map((path) => path.pathNumber)).toEqual(
      Array.from({ length: 103 }, (_, i) => i + 1),
    );
    expect(listed?.[102]?.receive).toEqual({
      locationNumber: 3,
      antennaNumber: 1,
      ...microSite(3),
    });
    const rest = found(await license('9005', { locationOffset: 1 }));
    expect(rest).toMatchObject({ pathTotal: 103, pathsShown: 0, locationOffset: 1 });
    expect(rest.locations.map((location) => location.locationNumber)).toEqual([2, 3, 4]);
  });

  it('carries no paths on a live license that files none or a non-live one', async () => {
    const pathless = found(await license('9006'));
    expect(pathless).toMatchObject({ pathTotal: 0, pathsShown: 0 });
    expect(pathless.locations[0]?.antennas).toHaveLength(1);
    expect(pathless.locations[0]?.antennas[0]).not.toHaveProperty('paths');
    expect(found(await license('9008'))).toMatchObject({
      technicalRetained: false,
      locations: [],
      pathTotal: 0,
      pathsShown: 0,
    });
  });

  it("lists a redacted individual's paths with no name on them", async () => {
    const result = found(await license('9007'));
    expect(result.license.licensee).toMatchObject({ name: null, redacted: true });
    expect(result.pathTotal).toBe(1);
    const paths = antennaAt(result, 1, 1)?.paths ?? [];
    expect(paths).toEqual([
      {
        pathNumber: 1,
        pathType: 'Fixed Point-to-Point',
        passiveReceiver: false,
        receiverCallsign: 'KZZ928',
        receive: {
          locationNumber: 2,
          antennaNumber: 1,
          latitude: dms(34, 28, 0),
          longitude: dms(119, 16, 0, true),
        },
      },
    ]);
    for (const path of paths) {
      for (const key of Object.keys(path)) expect(PATH_KEYS).toContain(key);
      for (const key of Object.keys(path.receive)) expect(RECEIVE_KEYS).toContain(key);
    }
    const json = JSON.stringify(result);
    for (const name of ['Pat Q Sample', 'SAMPLE HILL', '3 Sample Rd'])
      expect(json).not.toContain(name);
    // The names are in the data: redaction, not their absence, keeps them out.
    const unredacted = JSON.stringify(
      found(await open.getLicense({ usi: '9007', maxFrequencies: 100 })),
    );
    for (const name of ['Pat Q Sample', 'SAMPLE HILL', '3 Sample Rd'])
      expect(unredacted).toContain(name);
  });

  it('stops the window before the 101st path when sites and antennas leave room', async () => {
    const budget = await buildFixtureIndex({
      groups: ['micro'],
      weekly: { micro: pathBudgetWeekly() },
    });
    try {
      const paths = budget.service();
      const first = found(await paths.getLicense({ usi: '9101', maxFrequencies: 100 }));
      expect(first).toMatchObject({
        pathTotal: 101,
        pathsShown: 100,
        sitesShown: 2,
        locationTotal: 4,
        nextLocationOffset: 2,
      });
      expect(first.locations.map((location) => location.locationNumber)).toEqual([1, 2]);
      const second = found(
        await paths.getLicense({ usi: '9101', maxFrequencies: 100, locationNumber: 3 }),
      );
      expect(second).toMatchObject({ pathTotal: 101, pathsShown: 1, locationOffset: 2 });
      expect(second).not.toHaveProperty('nextLocationOffset');
      expect(pathsByAntenna(second)).toEqual([[3, 1, [101]]]);
    } finally {
      await budget.dispose();
    }
  });
});

describe('microwave paths across a daily file and a pre-path generation', () => {
  it('serves the paths a daily file replaced, and none for a license it cancelled', async () => {
    const daily = await buildFixtureIndex({
      groups: ['micro'],
      daily: { 'l_mw_mon.zip': DAILY_MW_MON },
    });
    try {
      const service = daily.service();
      const ridgeline = found(await service.getLicense({ usi: '9001', maxFrequencies: 100 }));
      expect(ridgeline).toMatchObject({ pathTotal: 2, pathsShown: 2 });
      expect(pathsByAntenna(ridgeline)).toEqual([
        [1, 3, [3]],
        [1, 4, [4]],
      ]);
      expect(antennaAt(ridgeline, 1, 3)?.paths?.[0]?.receiverCallsign).toBe('KZZ940');
      expect(found(await service.getLicense({ usi: '9002', maxFrequencies: 100 }))).toMatchObject({
        technicalRetained: false,
        pathTotal: 0,
      });
      expect(
        pathsByAntenna(found(await service.getLicense({ usi: '9009', maxFrequencies: 100 }))),
      ).toEqual([[1, 1, [1]]]);
      expect((await service.coverage()).index).not.toHaveProperty('pathCoverageIncomplete');
    } finally {
      await daily.dispose();
    }
  });

  it('discloses incomplete path coverage on a generation migrated from before paths, until a rebuild', async () => {
    const { mirror, service } = await coldService();
    const ingester = fixtureIngester(mirror, {
      client: new FakeIngestClient().withWeekly(['micro']),
      groups: ['micro'],
    });
    const { generation } = await ingester.rebuild();
    const v7 = createUlsStore(join(mirror.mirrorDir, generation));
    try {
      // The schema 7 layout: no paths table.
      (await v7.raw()).exec(
        'DROP INDEX paths_key; DROP TABLE paths; UPDATE schema_version SET version = 7;',
      );
    } finally {
      await v7.close();
    }

    expect((await service.coverage()).index).toMatchObject({
      ready: true,
      pathCoverageIncomplete: true,
    });
    const migrated = found(await service.getLicense({ usi: '9001', maxFrequencies: 100 }));
    expect(migrated).toMatchObject({ pathCoverageIncomplete: true, pathTotal: 0, pathsShown: 0 });
    expect(pathsByAntenna(migrated)).toEqual([]);

    await ingester.rebuild();
    expect((await service.coverage()).index).not.toHaveProperty('pathCoverageIncomplete');
    const rebuilt = found(await service.getLicense({ usi: '9001', maxFrequencies: 100 }));
    expect(rebuilt).not.toHaveProperty('pathCoverageIncomplete');
    expect(rebuilt.pathTotal).toBe(10);
  });
});

describe('findTransmitters', () => {
  it('lists sites within the radius, nearest first, with collapsed frequencies', async () => {
    const result = page(await on.findTransmitters(transmitters({ radiusKm: 1 })));
    expect(usis(result.rows)).toEqual(['1001', '1008']);
    expect(result.total).toBe(2);
    const [site, neighbor] = result.rows as [TransmitterSite, TransmitterSite];
    expect(site).toMatchObject({
      usi: '1001',
      callsign: 'KZZ901',
      licenseeName: 'Example Paging Co',
      licenseeRedacted: false,
      locationNumber: 1,
      locationTypeCode: 'F',
      distanceKm: 0,
      groundElevationM: 50.3,
      overallHeightM: 45.5,
      asrNumber: '1012345',
      county: 'KING',
      state: 'WA',
      stateFromCoordinates: false,
      frequencyCount: 2,
      frequenciesShown: 2,
    });
    expect(site.frequencies.map((f) => ({ ...f, emissions: [...f.emissions].sort() }))).toEqual([
      {
        frequencyMhz: 152.24,
        bandwidthMhz: 0.016,
        stationClasses: ['FB2'],
        maxErpW: 300,
        emissions: ['11K2F3E', '16K0F3E'],
      },
      { frequencyMhz: 454.1, stationClasses: ['FB'], maxErpW: 50, emissions: [] },
    ]);
    expect(neighbor.distanceKm).toBeGreaterThan(0.2);
    expect(neighbor.distanceKm).toBeLessThan(0.3);
    expect(neighbor).toMatchObject({ radioServiceCode: 'ZQ', radioServiceLabel: 'ZQ' });
    expect(neighbor.stateFromCoordinates).toBe(true);
  });

  it('widens with the radius and narrows with the radio service', async () => {
    const wide = page(await on.findTransmitters(transmitters({ radiusKm: 50 })));
    expect(wide.rows.map((row) => `${row.usi}:${row.locationNumber}`)).toEqual([
      '1001:1',
      '1008:1',
      '1001:2',
    ]);
    const tacoma = wide.rows[2];
    expect(tacoma?.distanceKm).toBeGreaterThan(30);
    expect(tacoma?.distanceKm).toBeLessThan(50);
    expect(
      usis(
        page(await on.findTransmitters(transmitters({ radiusKm: 50, radioService: 'ZQ' }))).rows,
      ),
    ).toEqual(['1008']);
  });

  it('keeps only sites, and frequencies, overlapping the band', async () => {
    const result = page(
      await on.findTransmitters(transmitters({ radiusKm: 50, band: band(152.2, 152.25) })),
    );
    expect(result.rows.map((row) => `${row.usi}:${row.locationNumber}`)).toEqual(['1001:1']);
    expect(result.rows[0]?.frequencyCount).toBe(1);
    expect(result.rows[0]?.frequencies.map((f) => f.frequencyMhz)).toEqual([152.24]);
  });

  it('caps frequencies per site and reports the full count', async () => {
    const [site] = page(
      await on.findTransmitters(transmitters({ radiusKm: 1, maxFrequenciesPerSite: 1 })),
    ).rows;
    expect(site).toMatchObject({ frequencyCount: 2, frequenciesShown: 1 });
    expect(site?.frequencies.map((f) => f.frequencyMhz)).toEqual([152.24]);
  });

  it('filters by live status', async () => {
    const portland = { latitude: dms(45, 30, 54.7), longitude: dms(122, 40, 42.2, true) };
    expect(page(await on.findTransmitters(transmitters({ ...portland }))).total).toBe(0);
    expect(
      usis(page(await on.findTransmitters(transmitters({ ...portland, status: 'X' }))).rows),
    ).toEqual(['1006']);
    expect(
      usis(page(await on.findTransmitters(transmitters({ ...portland, status: 'any' }))).rows),
    ).toEqual(['1006']);
  });

  it('finds a site across the antimeridian', async () => {
    const result = page(
      await on.findTransmitters(transmitters({ latitude: 52, longitude: 179.9, radiusKm: 25 })),
    );
    expect(usis(result.rows)).toEqual(['1009']);
    expect(result.rows[0]?.distanceKm).toBeCloseTo(20.5, 0);
    expect(result.rows[0]?.longitude).toBeCloseTo(-179.8, 6);
    expect(result.rows[0]).not.toHaveProperty('state');
    expect(
      page(
        await on.findTransmitters(transmitters({ latitude: 52, longitude: 179.9, radiusKm: 20 })),
      ).total,
    ).toBe(0);
  });

  it('applies redaction to the licensee name', async () => {
    const spokane = { latitude: dms(47, 39, 32), longitude: dms(117, 25, 33, true) };
    const [redacted] = page(await on.findTransmitters(transmitters(spokane))).rows;
    expect(redacted).toMatchObject({ usi: '1003', licenseeName: null, licenseeRedacted: true });
    const [open] = page(await off.findTransmitters(transmitters(spokane))).rows;
    expect(open).toMatchObject({ licenseeName: 'Pat Q Example', licenseeRedacted: false });
  });

  it('pages on distance without repeats and rejects a foreign cursor', async () => {
    const { pages, rows, total } = await allPages((cursor) =>
      on.findTransmitters(transmitters({ radiusKm: 50, limit: 1, cursor })),
    );
    expect(pages).toBe(3);
    expect(total).toBe(3);
    expect(rows.map((row) => `${row.usi}:${row.locationNumber}`)).toEqual([
      '1001:1',
      '1008:1',
      '1001:2',
    ]);
    const foreign = page(await on.searchLicenses(licenses({ limit: 1 }))).nextCursor;
    expect(await on.findTransmitters(transmitters({ cursor: foreign }))).toEqual({
      ok: false,
      reason: 'invalid_cursor',
    });
  });
});

describe('searchFrequencies', () => {
  it('merges site assignments and market blocks in frequency order', async () => {
    const result = page(await on.searchFrequencies(frequencies({})));
    expect(assignmentKeys(result.rows)).toEqual([
      'market:2001:2496',
      'market:2002:2496',
      'site:2001:1',
      'market:2001:2502',
      'site:2001:2',
      'market:2004:2524',
    ]);
    expect(result.total).toBe(6);
    expect(result.nextCursor).toBeUndefined();
    const site = result.rows[2];
    expect(site).toMatchObject({
      kind: 'site',
      usi: '2001',
      callsign: 'KZZ801',
      frequencyMhz: 2500,
      upperMhz: 2506,
      bandwidthMhz: 6,
      stationClasses: [],
      emissions: ['6M00D1D'],
      locationNumber: 1,
      state: 'ND',
      stateFromCoordinates: true,
    });
    expect(result.rows[0]).toEqual({
      kind: 'market',
      usi: '2001',
      callsign: 'KZZ801',
      isLease: false,
      licenseStatus: 'A',
      radioServiceCode: 'BR',
      radioServiceLabel: 'Broadband Radio Service',
      licenseeName: 'Sample Broadband Inc',
      licenseeRedacted: false,
      frequencyMhz: 2496,
      upperMhz: 2502,
      marketCode: 'BTA138',
      marketName: 'Fargo-Moorhead, ND-MN',
      channelBlock: 'A1',
      partitionAreaIds: [1],
    } satisfies FrequencyAssignment);
    expect(result.rows[1]).toMatchObject({ usi: '2002', isLease: true });
  });

  it('restricts by kind', async () => {
    expect(
      assignmentKeys(page(await on.searchFrequencies(frequencies({ kind: 'site' }))).rows),
    ).toEqual(['site:2001:1', 'site:2001:2']);
    const markets = page(await on.searchFrequencies(frequencies({ kind: 'market' })));
    expect(markets.total).toBe(4);
    expect(markets.rows.every((row) => row.kind === 'market')).toBe(true);
  });

  it('filters sites by site state and markets by the states in the market name', async () => {
    expect(
      assignmentKeys(page(await on.searchFrequencies(frequencies({ state: 'ND' }))).rows),
    ).toEqual([
      'market:2001:2496',
      'market:2002:2496',
      'site:2001:1',
      'market:2001:2502',
      'market:2004:2524',
    ]);
    expect(
      assignmentKeys(
        page(await on.searchFrequencies(frequencies({ state: 'MN', kind: 'site' }))).rows,
      ),
    ).toEqual(['site:2001:2']);
    expect(
      assignmentKeys(
        page(await on.searchFrequencies(frequencies({ band: band(2640, 2660), state: 'CA' }))).rows,
      ),
    ).toEqual(['market:2005:2650', 'site:2005:1']);
    expect(page(await on.searchFrequencies(frequencies({ state: 'TX' }))).total).toBe(0);
  });

  it('filters by licensee name and radio service', async () => {
    expect(
      assignmentKeys(
        page(await on.searchFrequencies(frequencies({ licensee: 'leaseholder' }))).rows,
      ),
    ).toEqual(['market:2002:2496']);
    expect(await on.searchFrequencies(frequencies({ licensee: '"*' }))).toEqual({
      ok: true,
      rows: [],
      total: 0,
    });
    const educational = page(
      await on.searchFrequencies(frequencies({ band: band(2600, 2700), radioService: 'ED' })),
    );
    expect(assignmentKeys(educational.rows)).toEqual(['market:2005:2650', 'site:2005:1']);
    const broadband = page(
      await on.searchFrequencies(frequencies({ band: band(2600, 2700), radioService: 'BR' })),
    );
    expect(assignmentKeys(broadband.rows)).toEqual(['market:2006:2618']);
  });

  it('collapses modulation steps and honors the live-status filter', async () => {
    const active = page(
      await on.searchFrequencies(frequencies({ band: band(152.24), kind: 'site' })),
    );
    expect(assignmentKeys(active.rows)).toEqual(['site:1001:1']);
    expect(active.rows[0]).toMatchObject({
      frequencyMhz: 152.24,
      bandwidthMhz: 0.016,
      stationClasses: ['FB2'],
      maxErpW: 300,
    });
    expect([...(active.rows[0]?.emissions ?? [])].sort()).toEqual(['11K2F3E', '16K0F3E']);
    const any = page(
      await on.searchFrequencies(frequencies({ band: band(152.24), kind: 'site', status: 'any' })),
    );
    expect(assignmentKeys(any.rows)).toEqual(['site:1001:1', 'site:1007:1']);
    expect(any.rows[1]).not.toHaveProperty('latitude');
    expect(any.rows[1]).toMatchObject({ licenseStatus: 'L', state: 'ID' });
  });

  it('matches band edges within half a hertz and no further', async () => {
    const sites = async (low: number, high = low) =>
      assignmentKeys(
        page(await on.searchFrequencies(frequencies({ band: band(low, high), kind: 'site' }))).rows,
      );
    // 2001 occupies 2497–2509 at site 1 and 2509–2521 at site 2.
    expect(await sites(2509)).toEqual(['site:2001:1', 'site:2001:2']);
    expect(await sites(2509.0000004)).toEqual(['site:2001:1', 'site:2001:2']);
    expect(await sites(2509.000001)).toEqual(['site:2001:2']);
    expect(await sites(2508.999999)).toEqual(['site:2001:1']);
    expect(await sites(2496.999999)).toEqual([]);

    const markets = async (low: number) =>
      assignmentKeys(
        page(await on.searchFrequencies(frequencies({ band: band(low), kind: 'market' }))).rows,
      );
    expect(await markets(2508.0000004)).toEqual(['market:2001:2502']);
    expect(await markets(2508.000001)).toEqual([]);
  });

  it('withholds individual names and excludes individuals from name search while redacting', async () => {
    const [redacted] = page(
      await on.searchFrequencies(frequencies({ band: band(158.7), kind: 'site' })),
    ).rows;
    expect(redacted).toMatchObject({ usi: '1003', licenseeName: null, licenseeRedacted: true });
    const [open] = page(
      await off.searchFrequencies(frequencies({ band: band(158.7), kind: 'site' })),
    ).rows;
    expect(open).toMatchObject({ licenseeName: 'Pat Q Example', licenseeRedacted: false });
    expect(
      page(await on.searchFrequencies(frequencies({ band: band(158.7), licensee: 'pat' }))).total,
    ).toBe(0);
    expect(
      page(await off.searchFrequencies(frequencies({ band: band(158.7), licensee: 'pat' }))).total,
    ).toBe(1);
  });

  it('pages the merged list without repeats', async () => {
    const { pages, rows, total } = await allPages((cursor) =>
      on.searchFrequencies(frequencies({ limit: 2, cursor })),
    );
    expect(pages).toBe(3);
    expect(total).toBe(6);
    expect(assignmentKeys(rows)).toEqual([
      'market:2001:2496',
      'market:2002:2496',
      'site:2001:1',
      'market:2001:2502',
      'site:2001:2',
      'market:2004:2524',
    ]);
  });

  it('rejects a cursor from another generation or query shape', async () => {
    expect(
      await on.searchFrequencies(
        frequencies({ cursor: forgeCursor('20990101T000000Z', 'f', 2496, 0, 2001, 0, 1) }),
      ),
    ).toEqual({ ok: false, reason: 'invalid_cursor' });
    expect(
      await on.searchFrequencies(
        frequencies({ cursor: forgeCursor('20260927T133855Z', 't', 0, 1001, 1, 1) }),
      ),
    ).toEqual({ ok: false, reason: 'invalid_cursor' });
  });
});

describe('searchFrequencies band walk', () => {
  let walker: UlsIndexService;
  beforeAll(() => {
    walker = fixture.service({ frequencySearch: WALK_LIMITS });
  });

  const SPECTRUM = band(0.001, 300_000);

  it.each<[string, Partial<SearchFrequenciesParams>]>([
    ['the whole spectrum', { band: SPECTRUM }],
    ['the whole spectrum at any live status', { band: SPECTRUM, status: 'any' }],
    ['site assignments across the spectrum', { band: SPECTRUM, kind: 'site', status: 'any' }],
    ['market blocks across the spectrum', { band: SPECTRUM, kind: 'market' }],
    ['the spectrum in one state', { band: SPECTRUM, state: 'ND' }],
    ['the spectrum for one licensee', { band: SPECTRUM, licensee: 'sample' }],
    ['the spectrum for one radio service', { band: SPECTRUM, radioService: 'BR' }],
    ['the spectrum at pending-legal status', { band: SPECTRUM, status: 'L' }],
    ['the VHF land mobile band', { band: band(150, 174), status: 'any' }],
    ['the BRS/EBS band', {}],
    ['one frequency', { band: band(2509) }],
  ])(
    'pages %s through the walk with exactly the rows, in order, of the exact search',
    async (_label, overrides) => {
      const exact = page(await on.searchFrequencies(frequencies({ ...overrides, limit: 200 })));
      expect(exact.nextCursor).toBeUndefined();
      expect(exact.totalIsLowerBound).toBeUndefined();
      for (const limit of [1, 2, 3, 200]) {
        const walked = await walkFrequencies(walker, frequencies({ ...overrides, limit }));
        expect(walked.rows, `limit ${limit}`).toEqual(exact.rows);
      }
    },
  );

  it('stops partway on a dense band with a short page that carries a cursor', async () => {
    const first = page(
      await walker.searchFrequencies(frequencies({ band: SPECTRUM, status: 'any', limit: 50 })),
    );
    expect(first.rows.length).toBeLessThan(50);
    expect(first.nextCursor).toBeDefined();
    const walked = await walkFrequencies(
      walker,
      frequencies({ band: SPECTRUM, status: 'any', limit: 50 }),
    );
    expect(walked.shortPages).toBeGreaterThan(1);
    expect(walked.lowerBound).toBe(true);
  });

  it('reports a total counted over part of the band as a lower bound', async () => {
    const exact = page(await on.searchFrequencies(frequencies({ band: SPECTRUM, limit: 200 })));
    const first = page(await walker.searchFrequencies(frequencies({ band: SPECTRUM, limit: 1 })));
    expect(first.totalIsLowerBound).toBe(true);
    expect(first.total).toBeGreaterThanOrEqual(first.rows.length);
    expect(first.total).toBeLessThanOrEqual(exact.total);
  });

  it('returns an empty page with a cursor, not a zero total, when the scan stops before any match', async () => {
    const result = page(
      await walker.searchFrequencies(
        frequencies({ band: SPECTRUM, kind: 'site', licensee: 'sample broadband' }),
      ),
    );
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBeDefined();
    expect(result.totalIsLowerBound).toBe(true);
    const walked = await walkFrequencies(
      walker,
      frequencies({ band: SPECTRUM, kind: 'site', licensee: 'sample broadband' }),
    );
    expect(assignmentKeys(walked.rows)).toEqual(['site:2001:1', 'site:2001:2']);
  });

  it('counts exactly when a walk sees the whole band in one call', async () => {
    const wide = fixture.service({ frequencySearch: { exactCap: 1, walkBudget: 1_000_000 } });
    const result = page(await wide.searchFrequencies(frequencies({ band: SPECTRUM, limit: 200 })));
    const exact = page(await on.searchFrequencies(frequencies({ band: SPECTRUM, limit: 200 })));
    expect(result.rows).toEqual(exact.rows);
    expect(result.total).toBe(exact.total);
    expect(result.totalIsLowerBound).toBeUndefined();
    expect(result.nextCursor).toBeUndefined();
  });

  it('keeps the exact count on a filter its index can narrow under the cap', async () => {
    const narrow = fixture.service({ frequencySearch: { exactCap: 4 } });
    const result = page(
      await narrow.searchFrequencies(
        frequencies({ band: SPECTRUM, licensee: 'sample broadband', limit: 1 }),
      ),
    );
    expect(result.totalIsLowerBound).toBeUndefined();
    expect(result.total).toBe(
      page(
        await on.searchFrequencies(frequencies({ band: SPECTRUM, licensee: 'sample broadband' })),
      ).total,
    );
  });
});

describe('searchFrequencies market blocks by state', () => {
  let markets: FixtureIndex;
  let service: UlsIndexService;
  beforeAll(async () => {
    markets = await buildFixtureIndex({
      groups: ['paging'],
      weekly: { paging: MARKET_STATES_WEEKLY },
    });
    service = markets.service();
  });
  afterAll(async () => {
    await markets?.dispose();
  });

  /** USIs of the 705 MHz market blocks a state matches. */
  const inState = async (state: string) =>
    usis(
      page(await service.searchFrequencies(frequencies({ band: band(705), kind: 'market', state })))
        .rows,
    );

  it('matches a code the area table does not list by the state code in its name', async () => {
    expect(await inState('GA')).toEqual(['7004']);
  });

  it('never reads a leading state name: Washington-Baltimore is not in WA', async () => {
    expect(await inState('WA')).not.toContain('7001');
  });

  it.each(['DC', 'MD', 'PA', 'VA', 'WV'])(
    'matches MTA010, which names no state, in %s by the FCC area table',
    async (state) => {
      expect(await inState(state)).toContain('7001');
    },
  );

  it.each(['CT', 'MA', 'NJ', 'NY', 'PA', 'VT'])(
    'matches BEA010, its name cut before its states, in %s',
    async (state) => {
      expect(await inState(state)).toContain('7002');
    },
  );

  it('matches a county-coded market by its FIPS state prefix', async () => {
    expect(await inState('AK')).toEqual(['7003']);
  });

  it.each(['TX', 'OK'])(
    'matches a P35 GSA in %s, where its license files a site',
    async (state) => {
      expect(await inState(state)).toEqual(['7005']);
    },
  );

  it('matches the rural CMA by the area table and skips the nationwide lease filing a WA site', async () => {
    expect(await inState('WA')).toEqual(['7010']);
  });

  it('matches nationwide and Gulf of Mexico markets in no state even where they file a site, and a Tribal land market without a site in none', async () => {
    const unmatched = ['7006', '7007', '7008', '7009'];
    for (const state of USPS_CODES) {
      const rows = await inState(state);
      expect(
        rows.filter((usi) => unmatched.includes(usi)),
        state,
      ).toEqual([]);
    }
    expect(await inState('LA')).toEqual([]);
  });

  it('pages a state with several matching blocks past the first page', async () => {
    const { pages, rows, total } = await allPages((cursor) =>
      service.searchFrequencies(
        frequencies({ band: band(705), kind: 'market', state: 'PA', limit: 1, cursor }),
      ),
    );
    expect({ pages, total, rows: usis(rows) }).toEqual({
      pages: 2,
      total: 2,
      rows: ['7001', '7002'],
    });
  });

  it('walks the band to exactly the rows of the exact search', async () => {
    const walker = markets.service({ frequencySearch: WALK_LIMITS });
    for (const state of ['PA', 'WA', 'TX', 'AK', 'LA']) {
      const exact = page(
        await service.searchFrequencies(
          frequencies({ band: band(0.001, 300_000), kind: 'both', state, limit: 200 }),
        ),
      );
      const walked = await walkFrequencies(
        walker,
        frequencies({ band: band(0.001, 300_000), kind: 'both', state, limit: 1 }),
      );
      expect(walked.rows, state).toEqual(exact.rows);
    }
  });
});

describe('generation switch', () => {
  it('picks up a newly published generation and rejects cursors from the old one', async () => {
    const index = await buildFixtureIndex({ groups: ['paging'] });
    try {
      const service = index.service();
      const first = page(await service.searchLicenses(licenses({ limit: 1 })));
      expect(first.nextCursor).toBeDefined();

      index.client.set('complete/l_paging.zip', {
        ...PAGING_WEEKLY,
        lastModified: '2026-10-04T13:38:55Z',
      });
      const rebuilt = await index.ingester.rebuild();
      expect(rebuilt.generation).toBe('fcc-uls-20261004T133855Z.db');

      expect((await service.coverage()).index.generation).toBe('fcc-uls-20261004T133855Z.db');
      expect(await service.searchLicenses(licenses({ cursor: first.nextCursor }))).toEqual({
        ok: false,
        reason: 'invalid_cursor',
      });
      expect(page(await service.searchLicenses(licenses({}))).total).toBe(8);
    } finally {
      await index.dispose();
    }
  });

  it('serves calls that arrive while the first pointer read is still in flight', async () => {
    const index = await buildFixtureIndex({ groups: ['paging'] });
    const service = new UlsIndexService({
      mirrorDir: index.mirrorDir,
      redactIndividuals: true,
      services: ['paging'],
    });
    try {
      const [first, second] = await Promise.all([
        service.searchLicenses(licenses({ limit: 1 })),
        service.searchLicenses(licenses({ limit: 1 })),
      ]);
      expect(page(first).total).toBeGreaterThan(0);
      expect(page(second).total).toBe(page(first).total);
    } finally {
      await service.close();
      await index.dispose();
    }
  });

  it('re-reads the pointer at most once per pointerCheckMs', async () => {
    const index = await buildFixtureIndex({ groups: ['paging'] });
    let clock = 0;
    const service = new UlsIndexService({
      mirrorDir: index.mirrorDir,
      pointerCheckMs: 60_000,
      now: () => clock,
      redactIndividuals: true,
      services: ['paging'],
    });
    try {
      expect((await service.coverage()).index.generation).toBe(FIXTURE_GENERATION);
      index.client.set('complete/l_paging.zip', {
        ...PAGING_WEEKLY,
        lastModified: '2026-10-04T13:38:55Z',
      });
      await index.ingester.rebuild();
      clock = 59_999;
      expect((await service.coverage()).index.generation).toBe(FIXTURE_GENERATION);
      clock = 60_000;
      expect((await service.coverage()).index.generation).toBe('fcc-uls-20261004T133855Z.db');
    } finally {
      await service.close();
      await index.dispose();
    }
  });

  it('opens the generation again on the next call after a failed open, not a pointer check later', async () => {
    const index = await buildFixtureIndex({ groups: ['paging'] });
    const generationPath = join(index.mirrorDir, FIXTURE_GENERATION);
    const service = new UlsIndexService({
      mirrorDir: index.mirrorDir,
      pointerCheckMs: 60_000,
      now: () => 0,
      redactIndividuals: true,
      services: ['paging'],
    });
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      // A directory in the generation's place fails the open, as a write lock held past the
      // busy timeout (another process migrating the generation) does.
      await rename(generationPath, `${generationPath}.aside`);
      await mkdir(generationPath);
      await expect(service.ready()).rejects.toThrow(/could not be read/);
      await rm(generationPath, { recursive: true });
      await rename(`${generationPath}.aside`, generationPath);
      expect(await service.ready()).toBe(true);
    } finally {
      vi.mocked(logger.error).mockRestore();
      await service.close();
      await index.dispose();
    }
  });
});

describe('filing quirks', () => {
  let quirks: FixtureIndex;
  let service: UlsIndexService;

  /** A `meta` value of the quirks generation, as a number. */
  async function metaNumber(key: string): Promise<number> {
    const store = createUlsStore(join(quirks.mirrorDir, quirks.generation));
    try {
      const db = await store.raw();
      return Number(
        db.prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?').get(key)?.value,
      );
    } finally {
      await store.close();
    }
  }

  beforeAll(async () => {
    quirks = await buildFixtureIndex({ groups: ['paging'], weekly: { paging: QUIRKS_WEEKLY } });
    service = quirks.service();
  });

  afterAll(async () => {
    await quirks?.dispose();
  });

  describe('an emission bandwidth 20% of the assigned frequency or wider', () => {
    it('is left out of the bandwidth and occupied band, keeping the designator as filed', async () => {
      const pickup = await service.getLicense({ usi: '5001', maxFrequencies: 100 });
      expect(pickup.found && pickup.locations[0]?.antennas[0]?.frequencies).toEqual([
        expect.objectContaining({ frequencyMhz: 470, bandwidthMhz: 6 }),
        { frequencyMhz: 638, emissions: ['5G75C3F'] },
      ]);
      const first = pickup.found ? pickup.locations[0]?.antennas[0]?.frequencies[0] : undefined;
      expect(first?.emissions.toSorted()).toEqual(['5G75C3F', '6M00C3F']);

      const radar = await service.getLicense({ usi: '5002', maxFrequencies: 100 });
      expect(radar.found && radar.locations[0]?.antennas[0]?.frequencies).toEqual([
        { frequencyMhz: 24150, emissions: ['24G1N0N'] },
        { frequencyMhz: 8500, bandwidthMhz: 1300, emissions: ['1G30NXN'] },
      ]);
    });

    it('matches no unrelated frequency and does not widen the stored site band', async () => {
      expect(await metaNumber(META_KEYS.maxSiteBand)).toBe(1300);
      const at = async (mhz: number) =>
        usis(page(await service.searchFrequencies(frequencies({ band: band(mhz) }))).rows);
      expect(await at(150)).toEqual([]);
      expect(await at(467)).toEqual(['5001']);
      expect(await at(638)).toEqual(['5001']);
      expect(await at(24150)).toEqual(['5002']);
      expect(await at(24100)).toEqual([]);
      const near = page(
        await service.findTransmitters(
          transmitters({
            latitude: dms(47, 30, 0),
            longitude: dms(122, 30, 0, true),
            radiusKm: 1,
            band: band(150),
          }),
        ),
      );
      expect(near.rows).toEqual([]);
    });
  });

  describe('a market block filed with a 0 lower edge (a PAL channel width)', () => {
    it('stays out of frequency matching and the stored market band', async () => {
      expect(await metaNumber(META_KEYS.maxMarketBand)).toBe(5);
      const markets = async (lowMhz: number, highMhz = lowMhz, radioService?: string) =>
        page(
          await service.searchFrequencies(
            frequencies({ band: band(lowMhz, highMhz), kind: 'market', radioService }),
          ),
        );
      expect((await markets(5)).total).toBe(0);
      expect((await markets(0, 10)).total).toBe(0);
      expect((await markets(3550, 3700, 'PL')).total).toBe(0);
    });

    it('lists in get_license as a channel width with no frequency', async () => {
      const pal = await service.getLicense({ usi: '5003', maxFrequencies: 100 });
      expect(pal.found && pal.license.market).toMatchObject({
        marketCode: 'CN53033',
        marketName: 'King, WA',
        blocks: [{ channelWidthMhz: 10 }],
      });
      const block = pal.found ? pal.license.market?.blocks[0] : undefined;
      expect(block).not.toHaveProperty('lowMhz');
      expect(block).not.toHaveProperty('highMhz');
    });
  });

  describe('a market block filed under several partition areas', () => {
    const PARTITIONS = [8183, 8184, 96978];

    it('returns one search row per license and band, listing the partition areas', async () => {
      const result = page(
        await service.searchFrequencies(frequencies({ band: band(1757), kind: 'market' })),
      );
      expect(result.total).toBe(1);
      expect(result.rows).toEqual([
        expect.objectContaining({
          usi: '5004',
          frequencyMhz: 1755,
          upperMhz: 1760,
          partitionAreaIds: PARTITIONS,
        }),
      ]);

      const { pages, rows, total } = await allPages((cursor) =>
        service.searchFrequencies(
          frequencies({ band: band(1755, 2160), kind: 'market', limit: 1, cursor }),
        ),
      );
      expect([pages, total]).toEqual([2, 2]);
      expect(assignmentKeys(rows)).toEqual(['market:5004:1755', 'market:5004:2155']);
    });

    it('lists each band once in get_license, with its partition areas', async () => {
      const result = await service.getLicense({ usi: '5004', maxFrequencies: 100 });
      expect(result.found && result.license.market?.blocks).toEqual([
        { lowMhz: 1755, highMhz: 1760, partitionAreaIds: PARTITIONS },
        { lowMhz: 2155, highMhz: 2160, partitionAreaIds: PARTITIONS },
      ]);
    });
  });

  describe('a location number the license files at several sites', () => {
    const WEST = { latitude: dms(47, 40, 0), longitude: dms(122, 22, 0, true) };
    const EAST = { latitude: dms(47, 40, 0), longitude: dms(122, 20, 0, true) };
    /** Equidistant from both sites under location 1. */
    const BETWEEN = { latitude: dms(47, 40, 0), longitude: dms(122, 21, 0, true) };
    const SITE_FIELDS = ['latitude', 'longitude', 'county', 'state', 'stateFromCoordinates'];
    const at = (point: { latitude: number; longitude: number }) => ({
      latitude: expect.closeTo(point.latitude, 9),
      longitude: expect.closeTo(point.longitude, 9),
    });

    it("lists every site in get_license, with the number's antennas and frequencies once", async () => {
      const result = await service.getLicense({ usi: '5005', maxFrequencies: 100 });
      if (!result.found) throw new Error('Expected KZZ505.');
      expect(result.locations.map((location) => location.locationNumber)).toEqual([1, 2]);
      const [shared, single] = result.locations;
      for (const field of SITE_FIELDS) expect(shared).not.toHaveProperty(field);
      expect(shared?.sites).toEqual([
        expect.objectContaining({
          ...at(WEST),
          city: 'Shoreline',
          groundElevationM: 120,
          overallHeightM: 10.4,
          name: '33 SR99 North Rd',
        }),
        expect.objectContaining({
          ...at(EAST),
          city: 'Seattle',
          groundElevationM: 60,
          overallHeightM: 6.7,
          name: '35 I5 Northgate',
        }),
      ]);
      // The two AN records differ only in height to tip, so that alone is withheld.
      expect(shared?.antennas).toEqual([
        {
          antennaNumber: 1,
          antennaTypeCode: 'T',
          azimuthDeg: 360,
          gainDbi: 7.6,
          make: 'GTTEU',
          model: 'OA-59',
          recordCount: 2,
          frequencies: [
            { frequencyMhz: 5895, upperMhz: 5905, stationClass: 'FB', eirpDbm: 23, emissions: [] },
            { frequencyMhz: 5915, upperMhz: 5925, stationClass: 'FB', eirpDbm: 23, emissions: [] },
          ],
        },
      ]);
      expect(single).toMatchObject({
        locationNumber: 2,
        city: 'Bellevue',
        name: 'Single Site',
        antennas: [{ antennaNumber: 1, heightToTipM: 15, make: 'ACME', model: 'X1' }],
      });
      expect(single).not.toHaveProperty('sites');
      expect(single?.antennas[0]).not.toHaveProperty('recordCount');
      expect(result.frequenciesShown).toBe(3);
    });

    it('returns each site in find_transmitters with its own details, paging past a distance tie', async () => {
      const { pages, rows, total } = await allPages((cursor) =>
        service.findTransmitters(transmitters({ ...BETWEEN, radiusKm: 2, limit: 1, cursor })),
      );
      expect([pages, total]).toEqual([2, 2]);
      expect(rows).toEqual([
        expect.objectContaining({
          usi: '5005',
          locationNumber: 1,
          ...at(WEST),
          groundElevationM: 120,
          overallHeightM: 10.4,
          sitesSharingNumber: 2,
        }),
        expect.objectContaining({
          usi: '5005',
          locationNumber: 1,
          ...at(EAST),
          groundElevationM: 60,
          overallHeightM: 6.7,
          sitesSharingNumber: 2,
        }),
      ]);
      expect(rows[0]?.distanceKm).toBe(rows[1]?.distanceKm);
      for (const site of rows) {
        expect(site.frequencies.map((frequency) => frequency.frequencyMhz)).toEqual([5895, 5915]);
        expect(site.frequencyCount).toBe(2);
      }

      const single = page(
        await service.findTransmitters(
          transmitters({ latitude: dms(47, 36, 0), longitude: dms(122, 12, 0, true), radiusKm: 1 }),
        ),
      );
      expect(single.rows).toEqual([expect.objectContaining({ usi: '5005', locationNumber: 2 })]);
      expect(single.rows[0]).not.toHaveProperty('sitesSharingNumber');
    });

    it("returns a frequency filed against the number once in search_frequencies, without one site's place", async () => {
      for (const state of [undefined, 'WA']) {
        const result = page(
          await service.searchFrequencies(frequencies({ band: band(5900), kind: 'site', state })),
        );
        expect(result.total, state).toBe(1);
        const [row] = result.rows;
        expect(row, state).toMatchObject({
          usi: '5005',
          locationNumber: 1,
          frequencyMhz: 5895,
          upperMhz: 5905,
          sitesSharingNumber: 2,
        });
        for (const field of SITE_FIELDS) expect(row, `${state} ${field}`).not.toHaveProperty(field);
      }

      const single = page(
        await service.searchFrequencies(frequencies({ band: band(5940), kind: 'site' })),
      );
      expect(single.rows).toEqual([
        expect.objectContaining({ locationNumber: 2, county: 'King', state: 'WA' }),
      ]);
      expect(single.rows[0]).not.toHaveProperty('sitesSharingNumber');
    });
  });

  describe('an ASR field holding something other than a registration number', () => {
    it('omits it from get_license, at a single site and at each site sharing a number', async () => {
      const result = await service.getLicense({ usi: '5005', maxFrequencies: 100 });
      if (!result.found) throw new Error('Expected KZZ505.');
      const [shared, single] = result.locations;
      for (const site of shared?.sites ?? []) expect(site).not.toHaveProperty('asrNumber');
      expect(shared?.sites).toHaveLength(2);
      expect(single?.asrNumber).toBe('1012345');

      const filed = await service.getLicense({ usi: '5002', maxFrequencies: 100 });
      if (!filed.found) throw new Error('Expected KZZ502.');
      expect(filed.locations[0]).not.toHaveProperty('asrNumber');
      expect(filed.locations[0]?.locationNumber).toBe(1);
    });

    it('omits it from find_transmitters rows and keeps a seven-digit number', async () => {
      const BETWEEN = { latitude: dms(47, 40, 0), longitude: dms(122, 21, 0, true) };
      const shared = page(
        await service.findTransmitters(transmitters({ ...BETWEEN, radiusKm: 2 })),
      );
      expect(shared.rows).toHaveLength(2);
      for (const row of shared.rows) expect(row).not.toHaveProperty('asrNumber');

      const near = (latitude: number, longitude: number) =>
        service.findTransmitters(transmitters({ latitude, longitude, radiusKm: 0.5 }));
      const single = page(await near(dms(47, 36, 0), dms(122, 12, 0, true)));
      expect(single.rows).toEqual([
        expect.objectContaining({ usi: '5005', locationNumber: 2, asrNumber: '1012345' }),
      ]);
      const fileNumber = page(await near(dms(47, 31, 0), dms(122, 31, 0, true)));
      expect(fileNumber.rows).toEqual([expect.objectContaining({ usi: '5002' })]);
      expect(fileNumber.rows[0]).not.toHaveProperty('asrNumber');
    });
  });
});

describe('locations filed as an operating area', () => {
  /** Location 1 of KZZ531; every other number sits due north of it. */
  const CENTER = { latitude: 46, longitude: -119 };
  const siteKey = (row: TransmitterSite) => `${row.locationNumber}:${row.locationTypeCode ?? '-'}`;

  let areas: FixtureIndex;
  let service: UlsIndexService;
  beforeAll(async () => {
    areas = await buildFixtureIndex({ groups: ['paging'], weekly: { paging: AREA_SITES_WEEKLY } });
    service = areas.service();
  });
  afterAll(async () => {
    await areas?.dispose();
  });

  const near = (overrides: Partial<FindTransmittersParams> = {}) =>
    service.findTransmitters(transmitters({ ...CENTER, ...overrides }));

  it('returns every location type at its filed coordinates, ranked by their distance', async () => {
    const result = page(await near());
    expect(result.total).toBe(7);
    expect(result.rows.map(siteKey)).toEqual(['1:F', '2:M', '3:T', '4:F', '5:-', '6:M', '6:M']);
    const distances = result.rows.map((row) => row.distanceKm);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    const [fixed, mobile] = result.rows;
    expect(fixed?.distanceKm).toBe(0);
    expect(mobile).toMatchObject({ latitude: expect.closeTo(dms(46, 0, 30), 9), longitude: -119 });
    expect(mobile?.distanceKm).toBeCloseTo(0.927, 3);
  });

  it('labels each location type and carries a filed radius whatever the type', async () => {
    const result = page(await near());
    expect(
      result.rows.map((row) => [row.locationTypeCode, row.locationTypeLabel, row.radiusKm]),
    ).toEqual([
      ['F', 'Fixed', undefined],
      ['M', 'Mobile', 4],
      ['T', 'Temporary Fixed', 80.5],
      ['F', 'Fixed', 1.5],
      [undefined, undefined, undefined],
      ['M', 'Mobile', 8],
      ['M', 'Mobile', 12],
    ]);
    const [fixed, , , , untyped, shared] = result.rows;
    expect(fixed).not.toHaveProperty('radiusKm');
    for (const field of ['locationTypeCode', 'locationTypeLabel', 'radiusKm']) {
      expect(untyped).not.toHaveProperty(field);
    }
    expect(shared).toMatchObject({ sitesSharingNumber: 2, radiusKm: 8 });
  });

  it('keeps one location type, counts only its rows, and pages through them', async () => {
    const fixed = page(await near({ locationType: 'F' }));
    expect([fixed.total, fixed.rows.map(siteKey)]).toEqual([2, ['1:F', '4:F']]);
    const temporary = page(await near({ locationType: 'T' }));
    expect([temporary.total, temporary.rows.map(siteKey)]).toEqual([1, ['3:T']]);

    const mobile = await allPages((cursor) => near({ locationType: 'M', limit: 1, cursor }));
    expect([mobile.pages, mobile.total]).toEqual([3, 3]);
    expect(mobile.rows.map((row) => [row.locationNumber, row.radiusKm])).toEqual([
      [2, 4],
      [6, 8],
      [6, 12],
    ]);

    // The types partition the unfiltered set: F, M, T, and the one untyped site.
    expect(fixed.total + mobile.total + temporary.total + 1).toBe(page(await near()).total);
    expect(page(await near({ locationType: '6' }))).toEqual({ ok: true, rows: [], total: 0 });
  });

  it('combines the location type with a band', async () => {
    const mobile = page(await near({ locationType: 'M', band: band(458.5) }));
    expect(mobile.rows.map(siteKey)).toEqual(['6:M', '6:M']);
    expect(page(await near({ locationType: 'F', band: band(458.5) })).total).toBe(0);
  });

  it("returns a shared location number's frequency without coordinates, type, or radius", async () => {
    for (const state of [undefined, 'WA']) {
      const result = page(
        await service.searchFrequencies(frequencies({ band: band(458.5), kind: 'site', state })),
      );
      expect(result.rows, state).toEqual([
        expect.objectContaining({ locationNumber: 6, sitesSharingNumber: 2 }),
      ]);
      for (const field of ['latitude', 'locationTypeCode', 'locationTypeLabel', 'radiusKm']) {
        expect(result.rows[0], `${state} ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it('carries the location type and a filed radius on single-site frequency rows', async () => {
    const at = async (mhz: number, state?: string) => {
      const result = page(
        await service.searchFrequencies(frequencies({ band: band(mhz), kind: 'site', state })),
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0];
    };
    for (const state of [undefined, 'WA']) {
      expect(await at(456.0125, state), state).toMatchObject({
        locationNumber: 2,
        locationTypeCode: 'M',
        locationTypeLabel: 'Mobile',
        radiusKm: 4,
        latitude: expect.closeTo(dms(46, 0, 30), 9),
      });
    }
    expect(await at(457.5)).toMatchObject({ locationTypeCode: 'T', radiusKm: 80.5 });
    expect(await at(452.5)).toMatchObject({ locationTypeLabel: 'Fixed', radiusKm: 1.5 });
    const fixed = await at(451.0125);
    expect(fixed).toMatchObject({ locationTypeCode: 'F', locationTypeLabel: 'Fixed' });
    expect(fixed).not.toHaveProperty('radiusKm');
    const untyped = await at(453.5);
    expect(untyped).toMatchObject({
      locationNumber: 5,
      latitude: expect.closeTo(dms(46, 2, 0), 9),
    });
    for (const field of ['locationTypeCode', 'locationTypeLabel', 'radiusKm']) {
      expect(untyped).not.toHaveProperty(field);
    }
  });
});

describe('an individual whose sites file names', () => {
  let individual: FixtureIndex;
  beforeAll(async () => {
    individual = await buildFixtureIndex({
      groups: ['paging'],
      weekly: { paging: INDIVIDUAL_SITES_WEEKLY },
    });
  });
  afterAll(async () => {
    await individual?.dispose();
  });

  it('withholds the name and address of every site, shared numbers included, while redacting', async () => {
    const result = await individual
      .service({ redactIndividuals: true })
      .getLicense({ callsign: 'KZZ521', maxFrequencies: 100 });
    if (!result.found) throw new Error('Expected KZZ521.');
    const [shared, single] = result.locations;
    expect(shared?.sites).toHaveLength(2);
    for (const site of [...(shared?.sites ?? []), single]) {
      expect(site).not.toHaveProperty('name');
      expect(site).not.toHaveProperty('address');
      expect(site).toHaveProperty('city');
    }
    const body = JSON.stringify(result);
    for (const filed of ['Robin', 'Sample', 'SAMPLE', 'Orchard', 'Ridge Rd']) {
      expect(body, filed).not.toContain(filed);
    }
  });

  it('returns them as filed with redaction off', async () => {
    const result = await individual
      .service({ redactIndividuals: false })
      .getLicense({ callsign: 'KZZ521', maxFrequencies: 100 });
    if (!result.found) throw new Error('Expected KZZ521.');
    const [shared, single] = result.locations;
    expect(shared?.sites?.map((site) => [site.name, site.address])).toEqual([
      ['Robin R Sample', '7 Orchard Ln'],
      ['SAMPLE BARN', '9 Orchard Ln'],
    ]);
    expect(single).toMatchObject({ name: 'Sample Ridge', address: '11 Ridge Rd' });
  });
});

describe('band classes', () => {
  let classes: FixtureIndex;
  let service: UlsIndexService;

  beforeAll(async () => {
    classes = await buildFixtureIndex({
      groups: ['paging'],
      weekly: { paging: BAND_CLASS_WEEKLY },
    });
    service = classes.service();
  });

  afterAll(async () => {
    await classes?.dispose();
  });

  /** `usi@frequency` of every row of one kind overlapping `[lowMhz, highMhz]`. */
  const matches = async (kind: 'market' | 'site', lowMhz: number, highMhz = lowMhz) =>
    page(
      await service.searchFrequencies(frequencies({ band: band(lowMhz, highMhz), kind })),
    ).rows.map((row) => `${row.usi}@${row.frequencyMhz}`);

  it('stores each frequency and market block in the class of its occupied width', async () => {
    const store = createUlsStore(join(classes.mirrorDir, classes.generation));
    try {
      const db = await store.raw();
      const rows = (sql: string) => db.prepare<{ c: number; f: number }>(sql).all();
      expect(
        rows('SELECT frequency_mhz AS f, band_class AS c FROM frequencies ORDER BY frequency_mhz'),
      ).toEqual([
        { f: 100, c: -4 },
        { f: 200, c: -3 },
        { f: 300, c: -14 },
        { f: 400, c: -5 },
        { f: 1000, c: 14 },
        { f: 9000, c: 11 },
      ]);
      expect(rows('SELECT lower AS f, band_class AS c FROM market_blocks ORDER BY lower')).toEqual([
        { f: 700, c: -1 },
        { f: 10000, c: 14 },
      ]);
    } finally {
      await store.close();
    }
  });

  it('matches a row as wide as its class ceiling, or just wider, at both edges and no further', async () => {
    expect(await matches('site', 99.96875)).toEqual(['6001@100']);
    expect(await matches('site', 100.03125)).toEqual(['6001@100']);
    expect(await matches('site', 100.0313)).toEqual([]);
    expect(await matches('site', 199.9687)).toEqual(['6001@200']);
    expect(await matches('site', 200.0313)).toEqual(['6001@200']);
    expect(await matches('site', 300)).toEqual(['6001@300']);
    expect(await matches('site', 300.000001)).toEqual([]);
    expect(await matches('market', 700.5)).toEqual(['6003@700']);
  });

  it('matches a wide filing anywhere inside it, the open class included', async () => {
    expect(await matches('site', 8200.5)).toEqual(['6002@1000', '6001@9000']);
    expect(await matches('site', 9799.5)).toEqual(['6002@1000', '6001@9000']);
    expect(await matches('site', 19999)).toEqual(['6002@1000']);
    expect(await matches('site', 20001)).toEqual([]);
    expect(await matches('market', 19999)).toEqual(['6003@10000']);
    expect(await matches('market', 9999, 10000)).toEqual(['6003@10000']);
  });

  it('matches a frequency filed with its upper edge below it at its assigned frequency alone, in both tools', async () => {
    /** `usi@frequency` of every frequency the transmitter search finds at 6001's site. */
    const transmitterMatches = async (lowMhz: number, highMhz = lowMhz) =>
      page(
        await service.findTransmitters(
          transmitters({
            latitude: dms(47, 32, 0),
            longitude: dms(122, 32, 0, true),
            radiusKm: 1,
            band: band(lowMhz, highMhz),
          }),
        ),
      ).rows.flatMap((row) => row.frequencies.map((f) => `${row.usi}@${f.frequencyMhz}`));

    const cases: [low: number, high: number, expected: string[]][] = [
      [400, 400, ['6001@400']],
      [350, 400, ['6001@400']],
      [300, 500, ['6001@300', '6001@400']],
      [350, 350, []],
      [360, 390, []],
    ];
    for (const [low, high, expected] of cases) {
      expect(await matches('site', low, high), `${low}–${high}`).toEqual(expected);
      expect(await transmitterMatches(low, high), `${low}–${high}`).toEqual(expected);
    }
    const [row] = page(
      await service.searchFrequencies(frequencies({ band: band(400), kind: 'site' })),
    ).rows;
    expect(row).toMatchObject({ frequencyMhz: 400, upperMhz: 350 });
  });

  it.each<[string, Partial<SearchFrequenciesParams>]>([
    ['every kind', { kind: 'both' }],
    ['site assignments', { kind: 'site' }],
    ['market blocks', { kind: 'market' }],
  ])(
    'walks wide filings for %s with exactly the rows of the exact search',
    async (_label, overrides) => {
      const walker = classes.service({ frequencySearch: WALK_LIMITS });
      for (const searched of [band(0.001, 300_000), band(150, 9000), band(9500, 19_999)]) {
        const params = frequencies({ band: searched, ...overrides });
        const exact = page(await service.searchFrequencies({ ...params, limit: 200 }));
        for (const limit of [1, 2, 200]) {
          const walked = await walkFrequencies(walker, { ...params, limit });
          expect(walked.rows, `${searched.lowMhz}–${searched.highMhz}, limit ${limit}`).toEqual(
            exact.rows,
          );
        }
      }
    },
  );
});

describe('radioServiceLabel', () => {
  it('labels a known code and falls back to the code itself', () => {
    expect(radioServiceLabel('CD')).toBe('Paging and Radiotelephone');
    expect(radioServiceLabel('ZQ')).toBe('ZQ');
  });

  it('falls back to the code for one named like an object member', () => {
    for (const code of ['constructor', 'toString', '__proto__']) {
      expect(radioServiceLabel(code)).toBe(code);
    }
  });
});
