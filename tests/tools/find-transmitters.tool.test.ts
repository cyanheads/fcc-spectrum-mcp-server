/**
 * @fileoverview Tests for `fcc_spectrum_find_transmitters` over the fixture index: the cold,
 * dangling, and malformed pointer states, every declared error reason on both surfaces,
 * coordinate and range validation, DMS and decimal inputs, blank optional inputs, unit
 * conversion, band filtering, cursor paging, the per-site frequency cap, zero-hit notices,
 * redaction, the antimeridian, the required enrichment on the zero-result and under-cap
 * pages, and `format()` parity with registry text carrying CR/LF and `|`.
 * @module tests/tools/find-transmitters.tool.test
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findTransmitters } from '@/mcp-server/tools/definitions/find-transmitters.tool.js';
import { POINTER_FILE, writePointer } from '@/services/uls/schema.js';
import {
  type ContractResult,
  contractText,
  dms,
  errorOf,
  expectCarries,
  expectDeclaredError,
  FIXTURE_GENERATION_ID,
  forgeCursor,
  formattedText,
  type PageEnrichment,
  releaseIndex,
  successOf,
  useIndex,
} from '../fixtures/tool-harness.js';
import { QUIRKS_WEEKLY } from '../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

type Output = Parameters<NonNullable<typeof findTransmitters.format>>[0];
type Site = Output['sites'][number];

interface SearchCenter {
  latitude: number;
  longitude: number;
  radiusKm: number;
}
type Page = Output & PageEnrichment & { searchCenter: SearchCenter };

const DATA_AS_OF = '2026-09-27T13:44:10Z';

/** Site 1 of USI 1001, filed at 47-36-22.3 N 122-19-55.6 W. */
const SEATTLE = { latitude: dms(47, 36, 22.3), longitude: dms(122, 19, 55.6, true) };
/** Site 1 of USI 1006 (status X). */
const PORTLAND = { latitude: dms(45, 30, 54.7), longitude: dms(122, 40, 42.2, true) };
/** Site 1 of USI 1003, an individual licensee. */
const SPOKANE = { latitude: dms(47, 39, 32), longitude: dms(117, 25, 33, true) };

const MARKET_HINT =
  'Market-area licenses (PCS, AWS, 700 MHz, 3.7 GHz) usually have no site records; call fcc_spectrum_search_frequencies with kind "market".';

const run = (input: Record<string, unknown>) => runToolContract(findTransmitters, input as never);
const page = (result: ContractResult) => successOf<Page>(result);
const siteIds = (sites: readonly Site[]) =>
  sites.map((site) => `${site.usi}:${site.locationNumber}`);

describe('index not available', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('find-transmitters-cold');
  });
  afterAll(async () => {
    await releaseIndex();
    await cold.remove();
  });

  it.each([
    ['a plain search', SEATTLE],
    ['a search whose band is invalid', { ...SEATTLE, frequency_low: 152, frequency_high: 151 }],
    ['a search with an unknown service', { ...SEATTLE, radio_service: 'Q9' }],
  ])('fails %s on a cold index with index_not_ready before any other check', async (_l, input) => {
    await useIndex(cold.mirrorDir);
    const result = await run(input);
    const error = expectDeclaredError(findTransmitters, result, 'index_not_ready');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe('No completed index generation is published yet.');
    expect(error.data?.retryable).toBe(false);
    expect(contractText(result)).toContain('not retryable');
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
  });

  it('fails with index_not_ready when current.json names a missing generation', async () => {
    const dangling = await makeTempMirror('find-transmitters-dangling');
    try {
      await writePointer(dangling.mirrorDir, {
        file: 'fcc-uls-20990101T000000Z.db',
        publishedAt: '2026-09-29T20:00:00Z',
      });
      await useIndex(dangling.mirrorDir);
      expectDeclaredError(findTransmitters, await run(SEATTLE), 'index_not_ready');
    } finally {
      await releaseIndex();
      await dangling.remove();
    }
  });

  it('fails with index_not_ready when current.json is malformed', async () => {
    const malformed = await makeTempMirror('find-transmitters-malformed');
    try {
      await writeFile(join(malformed.mirrorDir, POINTER_FILE), '{"file": 42');
      await useIndex(malformed.mirrorDir);
      expectDeclaredError(findTransmitters, await run(SEATTLE), 'index_not_ready');
    } finally {
      await releaseIndex();
      await malformed.remove();
    }
  });
});

describe('warm index', () => {
  let fixture: FixtureIndex;
  beforeAll(async () => {
    fixture = await buildFixtureIndex();
  });
  beforeEach(async () => {
    await useIndex(fixture.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await fixture.dispose();
  });

  describe('declared errors', () => {
    it.each([
      [
        'frequency_high below frequency_low',
        { frequency_low: 152, frequency_high: 151 },
        'frequency_high (151 MHz) is below frequency_low (152 MHz).',
      ],
      [
        'frequency_high without frequency_low',
        { frequency_high: 152 },
        'frequency_high was given without frequency_low.',
      ],
      [
        'frequency_high with a blank frequency_low',
        { frequency_low: '', frequency_high: 152 },
        'frequency_high was given without frequency_low.',
      ],
      [
        'a band above 300 GHz',
        { frequency_low: 299, frequency_high: 301, unit: 'GHz' },
        'The band reaches above 300 GHz (300000 MHz), the top of the radio spectrum ULS licenses.',
      ],
      [
        'one frequency above 300 GHz',
        { frequency_low: 300_001 },
        'The band reaches above 300 GHz (300000 MHz), the top of the radio spectrum ULS licenses.',
      ],
    ])('fails invalid_frequency_range for %s', async (_label, band, message) => {
      const result = await run({ ...SEATTLE, ...band });
      const error = expectDeclaredError(findTransmitters, result, 'invalid_frequency_range');
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(message);
      expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
    });

    it('accepts a band whose top is exactly 300 GHz', async () => {
      const result = page(
        await run({ ...SEATTLE, frequency_low: 299, frequency_high: 300, unit: 'GHz' }),
      );
      expect(result.appliedFilters).toMatchObject({
        frequency_low_mhz: 299_000,
        frequency_high_mhz: 300_000,
      });
      expect(result.sites).toEqual([]);
    });

    it('fails unknown_radio_service for a code neither the table nor the index holds', async () => {
      const error = expectDeclaredError(
        findTransmitters,
        await run({ ...SEATTLE, radio_service: ' q9 ' }),
        'unknown_radio_service',
      );
      expect(error.message).toBe('"Q9" is not a ULS radio service code.');
      expect(error.data?.radioService).toBe('Q9');
    });

    it('fails service_not_indexed for a known code no indexed group carries', async () => {
      const error = expectDeclaredError(
        findTransmitters,
        await run({ ...SEATTLE, radio_service: 'CL' }),
        'service_not_indexed',
      );
      expect(error.message).toBe(
        'Radio service CL (Cellular) is not in any service group this deployment indexes (paging, mdsitfs, amat).',
      );
      expect(error.data?.radioService).toBe('CL');
    });

    it.each([
      ['a cursor that does not decode', 'garbage'],
      ['a cursor from another generation', forgeCursor('20990101T000000Z', 't', 0, 1001, 1, 1)],
      ['a search_licenses cursor', forgeCursor(FIXTURE_GENERATION_ID, 'c', 'KZZ901', 1001)],
      ['a transmitter cursor missing a key', forgeCursor(FIXTURE_GENERATION_ID, 't', 0, 1001, 1)],
      [
        'a transmitter cursor with a string key',
        forgeCursor(FIXTURE_GENERATION_ID, 't', 0, '1001', 1, 1),
      ],
    ])('fails invalid_cursor for %s', async (_label, cursor) => {
      const result = await run({ ...SEATTLE, cursor });
      expectDeclaredError(findTransmitters, result, 'invalid_cursor');
      expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
    });

    it('logs invalid_cursor at notice, as a caller-input rejection rather than a fault', () => {
      expect(
        findTransmitters.errors?.find((entry) => entry.reason === 'invalid_cursor')?.severity,
      ).toBe('notice');
    });

    it.each([
      ['DMS minutes of 61', { ...SEATTLE, latitude: '47-61-00 N' }],
      ['a DMS latitude with no hemisphere', { ...SEATTLE, latitude: '47-36-22.3' }],
      ['a latitude with a longitude hemisphere', { ...SEATTLE, latitude: '47-36-22.3 W' }],
      ['a longitude with a latitude hemisphere', { ...SEATTLE, longitude: '122-19-55.6 N' }],
      ['DMS seconds of 60', { ...SEATTLE, longitude: '122-19-60 W' }],
      ['latitude 90.5', { ...SEATTLE, latitude: 90.5 }],
      ['a DMS latitude past 90', { ...SEATTLE, latitude: '91-00-00 N' }],
      ['longitude -180.5', { ...SEATTLE, longitude: -180.5 }],
      ['a blank latitude', { ...SEATTLE, latitude: '' }],
      ['a missing longitude', { latitude: SEATTLE.latitude }],
      ['radius_km 0.05', { ...SEATTLE, radius_km: 0.05 }],
      ['radius_km 100.5', { ...SEATTLE, radius_km: 100.5 }],
      ['limit 0', { ...SEATTLE, limit: 0 }],
      ['limit 101', { ...SEATTLE, limit: 101 }],
      ['a fractional limit', { ...SEATTLE, limit: 2.5 }],
      ['max_frequencies_per_site 0', { ...SEATTLE, max_frequencies_per_site: 0 }],
      ['max_frequencies_per_site 51', { ...SEATTLE, max_frequencies_per_site: 51 }],
      ['status C, which keeps no site records', { ...SEATTLE, status: 'C' }],
      ['unit Hz', { ...SEATTLE, frequency_low: 152, unit: 'Hz' }],
      ['frequency 0', { ...SEATTLE, frequency_low: 0 }],
      ['a negative frequency', { ...SEATTLE, frequency_low: -152 }],
      ['a three-character service code', { ...SEATTLE, radio_service: 'ABC' }],
      ['a cursor with spaces', { ...SEATTLE, cursor: 'has space' }],
    ])('rejects %s with InvalidParams', async (_label, input) => {
      const error = errorOf(await run(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
    });
  });

  describe('inputs', () => {
    it.each([
      ['dash DMS', '47-36-22.3 N', '122-19-55.6 W'],
      ['dash DMS with no space before the hemisphere', '47-36-22.3n', '122-19-55.6w'],
      ['degree-sign DMS', `47°36'22.3"N`, `122°19'55.6"W`],
      ['space-separated DMS', '47 36 22.3 N', '122 19 55.6 W'],
      ['decimal strings', String(SEATTLE.latitude), String(SEATTLE.longitude)],
      ['numbers', SEATTLE.latitude, SEATTLE.longitude],
    ])('reads %s as the same search center', async (_label, latitude, longitude) => {
      const result = page(await run({ latitude, longitude, radius_km: 1 }));
      expect(result.searchCenter).toEqual({ ...SEATTLE, radiusKm: 1 });
      expect(siteIds(result.sites)).toEqual(['1001:1', '1008:1']);
    });

    it('reads blank optional inputs as unset', async () => {
      const input = {
        ...SEATTLE,
        frequency_low: '',
        frequency_high: ' ',
        unit: '',
        radio_service: '  ',
        status: '',
        cursor: '',
      };
      const parsed = findTransmitters.input.parse(input);
      expect(parsed).toMatchObject({
        unit: 'MHz',
        status: 'A',
        radius_km: 5,
        limit: 25,
        max_frequencies_per_site: 10,
      });
      for (const key of ['frequency_low', 'frequency_high', 'radio_service', 'cursor'] as const) {
        expect(parsed[key]).toBeUndefined();
      }
      const result = page(await run(input));
      expect(result.appliedFilters).toEqual({ status: 'A', max_frequencies_per_site: 10 });
      expect(siteIds(result.sites)).toEqual(['1001:1', '1008:1']);
      expect(result.notice).toBeUndefined();
    });

    it('converts kHz to MHz and echoes the band in appliedFilters', async () => {
      const result = page(await run({ ...SEATTLE, frequency_low: 152_240, unit: 'khz' }));
      expect(result.appliedFilters).toEqual({
        frequency_low_mhz: 152.24,
        frequency_high_mhz: 152.24,
        status: 'A',
        max_frequencies_per_site: 10,
      });
      expect(siteIds(result.sites)).toEqual(['1001:1']);
    });

    it('converts GHz to MHz and lists only the frequencies inside the band', async () => {
      const result = page(
        await run({
          ...SEATTLE,
          radius_km: 50,
          frequency_low: 0.9,
          frequency_high: 1,
          unit: 'GHz',
        }),
      );
      expect(result.appliedFilters).toMatchObject({
        frequency_low_mhz: 900,
        frequency_high_mhz: 1000,
      });
      expect(siteIds(result.sites)).toEqual(['1008:1', '1001:2']);
      expect(result.sites.map((site) => site.frequencies.map((f) => f.frequencyMhz))).toEqual([
        [929.6125],
        [931.0125],
      ]);
    });

    it('counts only overlapping frequencies when a band is given', async () => {
      const result = page(await run({ ...SEATTLE, radius_km: 1, frequency_low: 454.1 }));
      expect(result.sites).toHaveLength(1);
      expect(result.sites[0]).toMatchObject({
        usi: '1001',
        frequencyCount: 1,
        frequenciesShown: 1,
        frequencies: [{ frequencyMhz: 454.1, stationClasses: ['FB'] }],
      });
    });

    it('filters by an index-observed service code the FCC table lacks', async () => {
      const result = page(await run({ ...SEATTLE, radius_km: 1, radio_service: 'zq' }));
      expect(result.appliedFilters).toEqual({
        radio_service: 'ZQ',
        status: 'A',
        max_frequencies_per_site: 10,
      });
      expect(result.sites).toEqual([
        expect.objectContaining({ usi: '1008', radioServiceCode: 'ZQ', radioServiceLabel: 'ZQ' }),
      ]);
    });
  });

  describe('paging', () => {
    it('discloses truncation and follows the cursor through three pages', async () => {
      const input = { ...SEATTLE, radius_km: 50, limit: 1 };
      const first = await run(input);
      const one = page(first);
      const notice =
        'Showing 1 of 3 sites; pass nextCursor as cursor with the same inputs for the next page.';
      expect(one).toMatchObject({ totalCount: 3, truncated: true, shown: 1, cap: 1, notice });
      expect(one.nextCursor).toEqual(expect.any(String));
      const rendered = contractText(first);
      expect(rendered).toContain(`**nextCursor:** ${one.nextCursor}`);
      expect(rendered).toContain(`> ${notice}`);
      expect(rendered).toContain('**truncated:** true');

      const two = page(await run({ ...input, cursor: one.nextCursor }));
      expect(two).toMatchObject({ totalCount: 3, truncated: true, shown: 1 });
      expect(two.notice).toBe(
        'Showing 1 of 3 sites; pass nextCursor as cursor with the same inputs for the next page.',
      );
      const three = page(await run({ ...input, cursor: two.nextCursor }));
      expect(three).toMatchObject({ totalCount: 3, truncated: false, shown: 1, cap: 1 });
      expect(three.nextCursor).toBeUndefined();
      expect(three.notice).toBeUndefined();
      const all = [...one.sites, ...two.sites, ...three.sites];
      expect(siteIds(all)).toEqual(['1001:1', '1008:1', '1001:2']);
      const distances = all.map((s) => s.distanceKm);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    });

    it('returns everything on one page when the limit covers it', async () => {
      const result = page(await run({ ...SEATTLE, radius_km: 50 }));
      expect(result).toMatchObject({ totalCount: 3, truncated: false, shown: 3, cap: 25 });
      expect(result.nextCursor).toBeUndefined();
    });
  });

  describe('per-site frequency cap', () => {
    it('lists the first frequencies and keeps the full count', async () => {
      const result = await run({ ...SEATTLE, radius_km: 1, max_frequencies_per_site: 1 });
      const structured = page(result);
      expect(structured.appliedFilters).toEqual({ status: 'A', max_frequencies_per_site: 1 });
      const [seattle] = structured.sites;
      expect(seattle).toMatchObject({
        usi: '1001',
        frequencyCount: 2,
        frequenciesShown: 1,
        frequencies: [{ frequencyMhz: 152.24 }],
      });
      expect(contractText(result).split('\n')).toContain('- **Frequencies:** 1 of 2 listed');
    });

    it('collapses a frequency filed on several modulation steps into one row', async () => {
      const [seattle] = page(await run({ ...SEATTLE, radius_km: 1 })).sites;
      expect(seattle?.frequencies[0]).toEqual({
        frequencyMhz: 152.24,
        bandwidthMhz: 0.016,
        stationClasses: ['FB2'],
        maxErpW: 300,
        emissions: ['11K2F3E', '16K0F3E'],
      });
      expect(seattle).toMatchObject({ frequencyCount: 2, frequenciesShown: 2 });
    });
  });

  describe('notices', () => {
    it('names the radius and status moves when nothing active is near Portland', async () => {
      const result = page(await run(PORTLAND));
      expect(result).toMatchObject({ totalCount: 0, shown: 0, sites: [] });
      expect(result.notice).toBe(
        `No transmitter site within 5 km matches these filters; raise radius_km (max 100) or pass status "any". ${MARKET_HINT}`,
      );
    });

    it('finds the term-pending Portland site under status "any"', async () => {
      const result = page(await run({ ...PORTLAND, status: 'ANY' }));
      expect(result.appliedFilters).toEqual({ status: 'any', max_frequencies_per_site: 10 });
      expect(result.sites).toEqual([
        expect.objectContaining({ usi: '1006', licenseStatus: 'X', distanceKm: 0 }),
      ]);
    });

    it('offers no options when the radius is at its maximum and status is "any"', async () => {
      const result = page(await run({ latitude: 0, longitude: 0, radius_km: 100, status: 'any' }));
      expect(result.notice).toBe(
        `No transmitter site within 100 km matches these filters. ${MARKET_HINT}`,
      );
    });

    it('lists every option for a band and service search with nothing on it', async () => {
      const result = page(
        await run({ ...SEATTLE, frequency_low: 500, frequency_high: 510, radio_service: 'CD' }),
      );
      expect(result.notice).toBe(
        `No transmitter site within 5 km is authorized on 500–510 MHz under these filters; raise radius_km (max 100), widen the band (lower frequency_low or raise frequency_high), drop radio_service, pass status "any", or call fcc_spectrum_search_frequencies to search by state. ${MARKET_HINT}`,
      );
    });

    it('suggests frequency_high for a single-frequency search with nothing on it', async () => {
      const result = page(await run({ ...SEATTLE, frequency_low: 500, status: 'any' }));
      expect(result.notice).toBe(
        `No transmitter site within 5 km is authorized on 500 MHz under these filters; raise radius_km (max 100), widen the band with frequency_high, or call fcc_spectrum_search_frequencies to search by state. ${MARKET_HINT}`,
      );
    });
  });

  describe('redaction', () => {
    it("withholds an individual licensee's name while redacting", async () => {
      const result = await run({ ...SPOKANE, radius_km: 1 });
      const [site] = page(result).sites;
      expect(site).toMatchObject({
        usi: '1003',
        callsign: 'KZZ903',
        licenseeName: null,
        licenseeRedacted: true,
        state: 'WA',
      });
      const rendered = contractText(result);
      expect(rendered.split('\n')).toContain(
        '- **Licensee:** Redacted (individual licensee) · **Redacted:** yes · **Lease:** no',
      );
      expect(rendered).not.toContain('Pat Q Example');
    });

    it("shows the individual's name with redaction off", async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = await run({ ...SPOKANE, radius_km: 1 });
      expect(page(result).sites[0]).toMatchObject({
        licenseeName: 'Pat Q Example',
        licenseeRedacted: false,
      });
      expect(contractText(result).split('\n')).toContain(
        '- **Licensee:** Pat Q Example · **Redacted:** no · **Lease:** no',
      );
    });
  });

  describe('the antimeridian', () => {
    it('finds a site across 180° from a center on the other side', async () => {
      const result = page(await run({ latitude: 52, longitude: 179.9, radius_km: 25 }));
      expect(result.sites).toEqual([
        expect.objectContaining({
          usi: '1009',
          callsign: 'KZZ909',
          latitude: 52,
          longitude: -179.8,
          frequencyCount: 1,
          frequencies: [{ frequencyMhz: 929.5, stationClasses: ['FB'], emissions: ['XYZ'] }],
        }),
      ]);
      expect(result.sites[0]?.distanceKm).toBeGreaterThan(20);
      expect(result.sites[0]?.distanceKm).toBeLessThan(25);
    });

    it('leaves it out when the radius stops short', async () => {
      const result = page(await run({ latitude: 52, longitude: 179.9, radius_km: 20 }));
      expect(result.sites).toEqual([]);
      expect(result.totalCount).toBe(0);
    });
  });

  describe('enrichment contract (runToolContract)', () => {
    it('carries every required field and the notice on the zero-result page', async () => {
      const result = await run(PORTLAND);
      const structured = page(result);
      expect(structured).toMatchObject({
        sites: [],
        dataAsOf: DATA_AS_OF,
        totalCount: 0,
        truncated: false,
        shown: 0,
        cap: 25,
        searchCenter: { ...PORTLAND, radiusKm: 5 },
        appliedFilters: { status: 'A', max_frequencies_per_site: 10 },
      });
      expect(structured.nextCursor).toBeUndefined();
      const rendered = contractText(result);
      expect(rendered).toContain('No sites matched.');
      expect(rendered).toContain(`**dataAsOf:** ${DATA_AS_OF}`);
      expect(rendered).toContain(
        `**Search center:** ${PORTLAND.latitude}, ${PORTLAND.longitude} · radius 5 km`,
      );
      expect(rendered).toContain('**Applied filters:** status="A" · max_frequencies_per_site=10');
      expect(rendered).toContain('**0 total**');
      expect(rendered).toContain(`> ${structured.notice}`);
    });

    it('carries every site field on an under-cap page, with no notice or cursor', async () => {
      const result = await run({ ...SEATTLE, radius_km: 1 });
      const structured = page(result);
      expect(structured).toMatchObject({
        dataAsOf: DATA_AS_OF,
        totalCount: 2,
        truncated: false,
        shown: 2,
        cap: 25,
        searchCenter: { ...SEATTLE, radiusKm: 1 },
        appliedFilters: { status: 'A', max_frequencies_per_site: 10 },
      });
      expect(structured.notice).toBeUndefined();
      expect(structured.nextCursor).toBeUndefined();
      expect(siteIds(structured.sites)).toEqual(['1001:1', '1008:1']);
      const rendered = contractText(result);
      expectCarries(rendered, structured.sites);
      expect(rendered).toContain('**2 total**');
      expect(rendered).toContain('**Lease:** no');
      expect(rendered).toContain(
        `**Search center:** ${SEATTLE.latitude}, ${SEATTLE.longitude} · radius 1 km`,
      );
      expect(rendered).not.toContain('nextCursor');
    });

    it('marks a filed state and a site that filed none', async () => {
      const result = await run({ ...SEATTLE, radius_km: 50 });
      const structured = page(result);
      expectCarries(contractText(result), structured.sites);
      const [seattle, unlisted, tacoma] = structured.sites;
      expect(seattle).toMatchObject({ county: 'KING', state: 'WA', stateFromCoordinates: false });
      expect(unlisted).not.toHaveProperty('locationTypeCode');
      expect(tacoma).toMatchObject({ usi: '1001', locationNumber: 2 });
      expect(contractText(result).split('\n')).toContain('- **Place:** KING, WA (state as filed)');
    });
  });
});

describe('filing quirks', () => {
  let quirks: FixtureIndex;
  beforeAll(async () => {
    quirks = await buildFixtureIndex({ groups: ['paging'], weekly: { paging: QUIRKS_WEEKLY } });
  });
  beforeEach(async () => {
    await useIndex(quirks.mirrorDir, { services: ['paging'] });
  });
  afterAll(async () => {
    await releaseIndex();
    await quirks.dispose();
  });

  it('returns each site under a shared location number and ties the frequencies to the number', async () => {
    const result = await run({ latitude: '47-40-00 N', longitude: '122-21-00 W', radius_km: 2 });
    const structured = page(result);
    expect(
      structured.sites.map((site) => [
        site.locationNumber,
        site.groundElevationM,
        site.sitesSharingNumber,
      ]),
    ).toEqual([
      [1, 120, 2],
      [1, 60, 2],
    ]);
    const rendered = contractText(result);
    expect(rendered.split('\n')).toContain(
      '- **Shared location number:** 2 sites share location 1; the frequencies below are filed against the number, and ULS does not say which site uses each.',
    );
    expectCarries(rendered, structured.sites);
  });
});

describe('format()', () => {
  const site: Site = {
    usi: '77',
    callsign: 'KZZ\r\n077',
    isLease: true,
    licenseStatus: 'A',
    radioServiceCode: 'CD',
    radioServiceLabel: 'Paging\r\nand Radiotelephone',
    licenseeName: 'Acme\r\nRadio\nCo',
    licenseeRedacted: false,
    locationNumber: 1,
    locationTypeCode: 'F',
    distanceKm: 1.5,
    latitude: 47.5,
    longitude: -122.25,
    groundElevationM: 50.3,
    overallHeightM: 45.5,
    asrNumber: '1012345',
    county: 'KI\r\nNG',
    state: 'WA',
    stateFromCoordinates: false,
    frequencyCount: 3,
    frequenciesShown: 1,
    frequencies: [
      {
        frequencyMhz: 152.24,
        bandwidthMhz: 0.0112,
        stationClasses: ['FB|2', 'FX\\O'],
        maxErpW: 250,
        maxEirpDbm: 55.5,
        emissions: ['11K2F3E', '10|M0'],
      },
    ],
  };

  it('flattens CR/LF in every registry text slot so each stays on its line', () => {
    const rendered = formattedText(findTransmitters.format?.({ sites: [site] }));
    expect(rendered).not.toContain('\r');
    const rows = rendered.split('\n');
    for (const line of [
      '## Transmitter sites (1 on this page)',
      '### 1.5 km · KZZ 077 · USI 77 · location 1',
      '- **Licensee:** Acme Radio Co · **Redacted:** no · **Lease:** yes',
      '- **Status:** A · **Service:** CD (Paging and Radiotelephone) · **Location type:** F',
      '- **Coordinates:** 47.5, -122.25 · **Ground elevation:** 50.3 m · **Overall height:** 45.5 m · **ASR:** 1012345',
      '- **Place:** KI NG, WA (state as filed)',
      '- **Frequencies:** 1 of 3 listed',
    ]) {
      expect(rows).toContain(line);
    }
    expectCarries(rendered, { ...site, frequencies: [] });
  });

  it('escapes | and \\ in the station-class and emission cells', () => {
    const rendered = formattedText(findTransmitters.format?.({ sites: [site] }));
    const row = rendered.split('\n').find((line) => line.startsWith('| 152.24 '));
    expect(row).toBe('| 152.24 | — | 0.0112 | FB\\|2, FX\\\\O | 250 | 55.5 | 11K2F3E, 10\\|M0 |');
    expect(row?.split(/(?<!\\)\|/)).toHaveLength(9);
  });

  it('renders a sparse site without inventing values', () => {
    const sparse: Site = {
      usi: '78',
      isLease: false,
      licenseStatus: 'L',
      radioServiceCode: 'ZQ',
      radioServiceLabel: 'ZQ',
      licenseeName: null,
      licenseeRedacted: false,
      locationNumber: 3,
      distanceKm: 0,
      latitude: 47,
      longitude: -122,
      frequencyCount: 0,
      frequenciesShown: 0,
      frequencies: [],
    };
    const rendered = formattedText(
      findTransmitters.format?.({
        sites: [
          sparse,
          { ...sparse, usi: '79', licenseeRedacted: true, state: 'WA', stateFromCoordinates: true },
        ],
        nextCursor: 'abc_DEF-1',
      }),
    );
    const rows = rendered.split('\n');
    expect(rows).toContain('### 0 km · (no callsign) · USI 78 · location 3');
    expect(rows).toContain('- **Licensee:** Not on file · **Redacted:** no · **Lease:** no');
    expect(rows).toContain('- **Status:** L · **Service:** ZQ (ZQ)');
    expect(rows).toContain('- **Coordinates:** 47, -122');
    expect(rows).toContain(
      '- **Licensee:** Redacted (individual licensee) · **Redacted:** yes · **Lease:** no',
    );
    expect(rows).toContain('- **Place:** WA (state derived from coordinates)');
    expect(rows.filter((line) => line.startsWith('- **Place:**'))).toHaveLength(1);
    expect(rendered).not.toContain('| Frequency MHz');
    expect(rendered.endsWith('**nextCursor:** abc_DEF-1')).toBe(true);
  });

  it('says so when no site matched', () => {
    const rendered = formattedText(findTransmitters.format?.({ sites: [] }));
    expect(rendered).toBe('## Transmitter sites (0 on this page)\n\nNo sites matched.');
  });
});
