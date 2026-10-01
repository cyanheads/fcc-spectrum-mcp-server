/**
 * @fileoverview Tests for `UlsIndexService` over a generation the real ingester builds from
 * the fixture zips: cold-index behavior (not ready, building, failed build, dangling and
 * malformed pointer), stored errors and read failures (an unreadable pointer, a generation
 * that will not open) kept free of the mirror path, readiness and service
 * codes, `searchLicenses`, `getLicense`, `findTransmitters`, `searchFrequencies` (redaction
 * on and off), and the switch to a newly published generation.
 * @module tests/services/uls/uls-index-service.test
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVICE_GROUPS } from '@/services/uls/codes.js';
import { LOCK_FILE, POINTER_FILE, writePointer } from '@/services/uls/schema.js';
import type {
  Band,
  FindTransmittersParams,
  FrequencyAssignment,
  LicenseSummary,
  PageResult,
  SearchFrequenciesParams,
  SearchLicensesParams,
  TransmitterSite,
} from '@/services/uls/types.js';
import { UlsIndexService } from '@/services/uls/uls-index-service.js';
import { DAILY_PG_MON, FakeIngestClient, PAGING_WEEKLY } from '../../fixtures/uls-fixtures.js';
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
function page<T>(result: PageResult<T>): { nextCursor?: string; rows: T[]; total: number } {
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
      'current.json names fcc-uls-20260101T000000Z.db, which is missing from the mirror directory; run mirror:init to rebuild the index.';
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
   * `data` path and no `cause` (the framework forwards a cause's message as `rootCause`); the
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
    // A directory where the generation file should be: the store's open fails, naming the path.
    const generationPath = join(mirror.mirrorDir, FIXTURE_GENERATION);
    await mkdir(generationPath);
    await writePointer(mirror.mirrorDir, {
      file: FIXTURE_GENERATION,
      publishedAt: '2026-09-29T20:00:00Z',
    });
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const failure = await service.coverage().catch((err: unknown) => err);
      expectPathFree(mirror, failure, generationPath);
      expect((failure as Error).message).toBe(
        `The local ULS index could not be read: Failed to open mirror store at ${FIXTURE_GENERATION}`,
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
      marketCode: 'BTA144',
      marketName: 'Fargo-Moorhead, ND-MN',
      channelBlock: 'A1',
      blocks: [
        { lowMhz: 2496, highMhz: 2502 },
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

  it("omits an individual's site address only while redacting", async () => {
    const redacted = await on.getLicense({ callsign: 'KZZ903', maxFrequencies: 10 });
    if (!redacted.found) throw new Error('expected a record');
    expect(redacted.locations[0]).not.toHaveProperty('address');
    expect(redacted.locations[0]).toMatchObject({
      city: 'SPOKANE',
      state: 'WA',
      stateFromCoordinates: false,
    });
    expect(redacted.license.licensee).toMatchObject({ name: null, redacted: true });
    const open = await off.getLicense({ callsign: 'KZZ903', maxFrequencies: 10 });
    expect(open.found && open.locations[0]?.address).toBe('42 Private Lane');
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
      marketCode: 'BTA144',
      marketName: 'Fargo-Moorhead, ND-MN',
      channelBlock: 'A1',
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
        frequencies({ cursor: forgeCursor('20260927T133855Z', 't', 0, 1001, 1) }),
      ),
    ).toEqual({ ok: false, reason: 'invalid_cursor' });
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
});
