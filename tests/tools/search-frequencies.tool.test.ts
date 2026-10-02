/**
 * @fileoverview Tests for `fcc_spectrum_search_frequencies` over the fixture index: the cold,
 * dangling, and malformed pointer states, every declared error reason on both surfaces,
 * input validation and blank optional inputs, unit conversion, kind and state filtering,
 * the merged frequency order and cursor paging, the status, state, redaction, and zero-hit
 * notices, a single site's location type and radius (none on a shared location number), the
 * required enrichment on the zero-result and under-cap pages, and `format()` parity with
 * registry text carrying CR/LF and `|`.
 * @module tests/tools/search-frequencies.tool.test
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchFrequencies } from '@/mcp-server/tools/definitions/search-frequencies.tool.js';
import { POINTER_FILE, writePointer } from '@/services/uls/schema.js';
import {
  type ContractResult,
  contractText,
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
import {
  AREA_SITES_WEEKLY,
  MARKET_CODES_WEEKLY,
  MARKET_STATES_WEEKLY,
  QUIRKS_WEEKLY,
} from '../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

type Output = Parameters<NonNullable<typeof searchFrequencies.format>>[0];
type Assignment = Output['assignments'][number];
type Page = Output & PageEnrichment & { totalIsLowerBound?: boolean };

const DATA_AS_OF = '2026-09-27T13:44:10Z';

/** The BRS/EBS band every active block and site in it overlaps. */
const BRS = { frequency_low: 2496, frequency_high: 2530 };

/** Every row of {@link BRS}, frequency ascending: market blocks `m`, site assignments `s`. */
const BRS_ORDER = [
  'm2001@2496',
  'm2002@2496',
  's2001:1@2500',
  'm2001@2502',
  's2001:2@2512',
  'm2004@2524',
];

const ACTIVE_ONLY =
  'Only active records were searched; pass status "any" to include pending-legal and term-pending ones.';
const MARKET_STATE_RULE =
  'State filtering on market licenses matches a block whose FCC market area reaches the state, whose market name carries the state code, or whose license files a site there; it skips nationwide and Gulf of Mexico markets, and Tribal land (TL) and MVDDS (MVD) markets with no state code in the name.';
const MARKET_CODE_POINTER =
  'To search one market, including one this rule skips, pass its code as market_code without state.';
/** The state fragment of a search without market_code. */
const STATE_FRAGMENT = `${MARKET_STATE_RULE} ${MARKET_CODE_POINTER}`;
const CODE_SOURCE =
  'market_code matches a market code exactly; codes come from the marketCode field of fcc_spectrum_search_licenses and fcc_spectrum_search_frequencies results.';
const NAME_SEARCH_EXCLUDES_INDIVIDUALS =
  'Individual licensees are excluded from name search while redaction is on; search without licensee to see them.';
const NEXT_PAGE = (shown: number, total: number | string) =>
  `Showing ${shown} of ${total} rows; pass nextCursor as cursor with the same inputs for the next page.`;
const STOPPED_PARTWAY =
  'The scan stopped partway through the band to keep the call short; pass nextCursor as cursor with the same inputs to continue it.';

/** The whole spectrum the tool accepts, in MHz. */
const SPECTRUM = { frequency_low: 0.001, frequency_high: 300_000 };

const run = (input: Record<string, unknown>) => runToolContract(searchFrequencies, input as never);
const page = (result: ContractResult) => successOf<Page>(result);

/** `m<usi>@<lower>` for a market block, `s<usi>:<location>@<frequency>` for a site row. */
const rowIds = (rows: readonly Assignment[]) =>
  rows.map((row) =>
    row.kind === 'market'
      ? `m${row.usi}@${row.frequencyMhz}`
      : `s${row.usi}:${row.locationNumber}@${row.frequencyMhz}`,
  );

describe('index not available', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('search-frequencies-cold');
  });
  afterAll(async () => {
    await releaseIndex();
    await cold.remove();
  });

  it.each([
    ['a band search', BRS],
    ['a search whose band is invalid', { frequency_low: 152, frequency_high: 151 }],
    ['a search with an unknown service', { frequency_low: 152, radio_service: 'Q9' }],
  ])('fails %s on a cold index with index_not_ready before any other check', async (_l, input) => {
    await useIndex(cold.mirrorDir);
    const result = await run(input);
    const error = expectDeclaredError(searchFrequencies, result, 'index_not_ready');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe('No completed index generation is published yet.');
    expect(error.data?.retryable).toBe(false);
    expect(contractText(result)).toContain('not retryable');
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
  });

  it('fails with index_not_ready when current.json names a missing generation', async () => {
    const dangling = await makeTempMirror('search-frequencies-dangling');
    try {
      await writePointer(dangling.mirrorDir, {
        file: 'fcc-uls-20990101T000000Z.db',
        publishedAt: '2026-09-29T20:00:00Z',
      });
      await useIndex(dangling.mirrorDir);
      expectDeclaredError(searchFrequencies, await run(BRS), 'index_not_ready');
    } finally {
      await releaseIndex();
      await dangling.remove();
    }
  });

  it('fails with index_not_ready when current.json is malformed', async () => {
    const malformed = await makeTempMirror('search-frequencies-malformed');
    try {
      await writeFile(join(malformed.mirrorDir, POINTER_FILE), '{"file": 42');
      await useIndex(malformed.mirrorDir);
      expectDeclaredError(searchFrequencies, await run(BRS), 'index_not_ready');
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
        'frequency_high below frequency_low in GHz',
        { frequency_low: 2.5, frequency_high: 2.4, unit: 'ghz' },
        'frequency_high (2.4 GHz) is below frequency_low (2.5 GHz).',
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
      const result = await run(band);
      const error = expectDeclaredError(searchFrequencies, result, 'invalid_frequency_range');
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(message);
      expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
    });

    it('accepts a band whose top is exactly 300 GHz', async () => {
      const result = page(await run({ frequency_low: 299, frequency_high: 300, unit: 'GHz' }));
      expect(result.appliedFilters).toMatchObject({
        frequency_low_mhz: 299_000,
        frequency_high_mhz: 300_000,
      });
      expect(result.assignments).toEqual([]);
    });

    it('fails unknown_radio_service for a code neither the table nor the index holds', async () => {
      const error = expectDeclaredError(
        searchFrequencies,
        await run({ ...BRS, radio_service: ' q9 ' }),
        'unknown_radio_service',
      );
      expect(error.message).toBe('"Q9" is not a ULS radio service code.');
      expect(error.data?.radioService).toBe('Q9');
    });

    it('fails service_not_indexed for a known code no indexed group carries', async () => {
      const error = expectDeclaredError(
        searchFrequencies,
        await run({ ...BRS, radio_service: 'CL' }),
        'service_not_indexed',
      );
      expect(error.message).toBe(
        'Radio service CL (Cellular) is not in any service group this deployment indexes (paging, mdsitfs, amat).',
      );
      expect(error.data?.radioService).toBe('CL');
    });

    it.each([
      ['a cursor that does not decode', 'garbage'],
      [
        'a cursor from another generation',
        forgeCursor('20990101T000000Z', 'f', 2496, 1, 2001, 0, 1),
      ],
      ['a find_transmitters cursor', forgeCursor(FIXTURE_GENERATION_ID, 't', 0, 1001, 1, 1)],
      [
        'a frequency cursor missing a key',
        forgeCursor(FIXTURE_GENERATION_ID, 'f', 2496, 1, 2001, 0),
      ],
      [
        'a frequency cursor with a string key',
        forgeCursor(FIXTURE_GENERATION_ID, 'f', 2496, 'market', 2001, 0, 1),
      ],
    ])('fails invalid_cursor for %s', async (_label, cursor) => {
      const result = await run({ ...BRS, cursor });
      expectDeclaredError(searchFrequencies, result, 'invalid_cursor');
      expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
    });

    it('logs invalid_cursor at notice, as a caller-input rejection rather than a fault', () => {
      expect(
        searchFrequencies.errors?.find((entry) => entry.reason === 'invalid_cursor')?.severity,
      ).toBe('notice');
    });

    it.each([
      ['a blank frequency_low', { frequency_low: '' }],
      ['a whitespace frequency_low', { frequency_low: '  ', frequency_high: 2530 }],
      ['a missing frequency_low', { frequency_high: 2530 }],
      ['frequency_low 0', { frequency_low: 0 }],
      ['a negative frequency_low', { frequency_low: -2496 }],
      ['frequency_high 0', { frequency_low: 2496, frequency_high: 0 }],
      ['an unknown kind', { ...BRS, kind: 'tower' }],
      ['an unknown state name', { ...BRS, state: 'Atlantis' }],
      ['a three-character service code', { ...BRS, radio_service: 'ABC' }],
      ['a 201-character licensee', { ...BRS, licensee: 'x'.repeat(201) }],
      ['a licensee with no letter or digit', { ...BRS, licensee: '!!!' }],
      ['limit 0', { ...BRS, limit: 0 }],
      ['limit 201', { ...BRS, limit: 201 }],
      ['a fractional limit', { ...BRS, limit: 1.5 }],
      ['status E, which keeps no frequency records', { ...BRS, status: 'E' }],
      ['unit Hz', { ...BRS, unit: 'Hz' }],
      ['a cursor with spaces', { ...BRS, cursor: 'has space' }],
    ])('rejects %s with InvalidParams', async (_label, input) => {
      const error = errorOf(await run(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
    });
  });

  describe('inputs', () => {
    it('reads blank optional inputs as unset', async () => {
      const input = {
        ...BRS,
        unit: '',
        kind: ' ',
        state: '',
        radio_service: '  ',
        licensee: '',
        status: '',
        cursor: '',
      };
      const parsed = searchFrequencies.input.parse(input);
      expect(parsed).toMatchObject({ unit: 'MHz', kind: 'both', status: 'A', limit: 50 });
      expect(searchFrequencies.input.parse({ ...BRS, kind: ' Market ' }).kind).toBe('market');
      expect(searchFrequencies.input.parse({ ...BRS, kind: 'SITE' }).kind).toBe('site');
      for (const key of ['state', 'radio_service', 'licensee', 'cursor'] as const) {
        expect(parsed[key]).toBeUndefined();
      }
      const result = page(await run(input));
      expect(result.appliedFilters).toEqual({
        frequency_low_mhz: 2496,
        frequency_high_mhz: 2530,
        kind: 'both',
        status: 'A',
      });
      expect(rowIds(result.assignments)).toEqual(BRS_ORDER);
      expect(result.notice).toBeUndefined();
    });

    it('reads a blank frequency_high as one frequency', async () => {
      const result = page(await run({ frequency_low: 2512, frequency_high: '' }));
      expect(result.appliedFilters).toMatchObject({
        frequency_low_mhz: 2512,
        frequency_high_mhz: 2512,
      });
      expect(rowIds(result.assignments)).toEqual(['s2001:2@2512']);
    });

    it('converts GHz to MHz and echoes the band in appliedFilters', async () => {
      const result = page(await run({ frequency_low: 2.5, frequency_high: 2.75, unit: 'GHz' }));
      expect(result.appliedFilters).toEqual({
        frequency_low_mhz: 2500,
        frequency_high_mhz: 2750,
        kind: 'both',
        status: 'A',
      });
      expect(result.totalCount).toBe(9);
      expect(result.assignments).toHaveLength(9);
    });

    it('converts kHz to MHz', async () => {
      const result = page(await run({ frequency_low: 158_700, unit: 'kHz' }));
      expect(result.appliedFilters).toMatchObject({
        frequency_low_mhz: 158.7,
        frequency_high_mhz: 158.7,
      });
      expect(rowIds(result.assignments)).toEqual(['s1003:1@158.7']);
    });

    it.each([
      ['site', ['s2001:1@2500', 's2001:2@2512']],
      ['market', ['m2001@2496', 'm2002@2496', 'm2001@2502', 'm2004@2524']],
    ])('returns only %s rows for that kind', async (kind, expected) => {
      const result = page(await run({ ...BRS, kind }));
      expect(result.appliedFilters).toMatchObject({ kind });
      expect(rowIds(result.assignments)).toEqual(expected);
    });

    it('labels site and market rows with their own fields', async () => {
      const { assignments } = page(await run(BRS));
      const site = assignments.find((row) => row.kind === 'site');
      const lease = assignments.find((row) => row.usi === '2002');
      expect(site).toMatchObject({
        usi: '2001',
        callsign: 'KZZ801',
        frequencyMhz: 2500,
        upperMhz: 2506,
        bandwidthMhz: 6,
        emissions: ['6M00D1D'],
        locationNumber: 1,
        state: 'ND',
        stateFromCoordinates: true,
      });
      expect(site).not.toHaveProperty('marketCode');
      expect(lease).toMatchObject({
        kind: 'market',
        callsign: 'L000000001',
        isLease: true,
        licenseeName: 'Leaseholder Wireless LLC',
        frequencyMhz: 2496,
        upperMhz: 2502,
        marketCode: 'BTA138',
        marketName: 'Fargo-Moorhead, ND-MN',
        channelBlock: 'A1',
      });
      expect(lease).not.toHaveProperty('locationNumber');
    });

    it('matches a market whose name lists several states separated by a slash', async () => {
      const result = page(
        await run({ frequency_low: 2620, state: 'south dakota', kind: 'market' }),
      );
      expect(result.appliedFilters).toMatchObject({ state: 'SD', kind: 'market' });
      expect(result.assignments).toEqual([
        expect.objectContaining({ usi: '2006', callsign: 'L000000003', isLease: true }),
      ]);
      expect(result.notice).toBe(STATE_FRAGMENT);
    });
  });

  describe('paging', () => {
    it('discloses truncation and follows the cursor through three pages in frequency order', async () => {
      const input = { ...BRS, limit: 2 };
      const first = await run(input);
      const one = page(first);
      expect(one).toMatchObject({
        totalCount: 6,
        truncated: true,
        shown: 2,
        cap: 2,
        notice: NEXT_PAGE(2, 6),
      });
      const rendered = contractText(first);
      expect(rendered).toContain(`**nextCursor:** ${one.nextCursor}`);
      expect(rendered).toContain(`> ${NEXT_PAGE(2, 6)}`);
      expect(rendered).toContain('**truncated:** true');

      const two = page(await run({ ...input, cursor: one.nextCursor }));
      expect(two).toMatchObject({
        totalCount: 6,
        truncated: true,
        shown: 2,
        notice: NEXT_PAGE(2, 6),
      });
      const three = page(await run({ ...input, cursor: two.nextCursor }));
      expect(three).toMatchObject({ totalCount: 6, truncated: false, shown: 2, cap: 2 });
      expect(three.nextCursor).toBeUndefined();
      expect(three.notice).toBeUndefined();
      expect(rowIds([...one.assignments, ...two.assignments, ...three.assignments])).toEqual(
        BRS_ORDER,
      );
    });
  });

  describe('band walk', () => {
    it('says the scan stopped partway on a short page with a cursor, never that nothing matched', async () => {
      await useIndex(fixture.mirrorDir, {
        frequencySearch: { exactCap: 1, walkBudget: 2, windowTarget: 1 },
      });
      const input = { ...SPECTRUM, kind: 'site', licensee: 'sample broadband' };
      const first = await run(input);
      const one = page(first);
      expect(one).toMatchObject({
        assignments: [],
        totalCount: 0,
        totalIsLowerBound: true,
        truncated: true,
        shown: 0,
        notice: `${NAME_SEARCH_EXCLUDES_INDIVIDUALS} ${STOPPED_PARTWAY}`,
      });
      expect(one.nextCursor).toBeDefined();
      expect(contractText(first)).not.toContain('No authorization');

      const rows: Assignment[] = [];
      let cursor = one.nextCursor;
      for (let calls = 0; cursor && calls < 100; calls++) {
        const next = page(await run({ ...input, cursor }));
        rows.push(...next.assignments);
        cursor = next.nextCursor;
      }
      expect(cursor).toBeUndefined();
      expect(rowIds(rows)).toEqual(['s2001:1@2500', 's2001:2@2512']);
    });

    it('says "at least" on both surfaces when the total is a lower bound', async () => {
      await useIndex(fixture.mirrorDir, {
        frequencySearch: { exactCap: 1, walkBudget: 1_000, windowTarget: 1 },
      });
      const result = await run({
        frequency_low: 150,
        frequency_high: 174,
        status: 'any',
        limit: 1,
      });
      const structured = page(result);
      expect(structured).toMatchObject({ totalIsLowerBound: true, truncated: true, shown: 1 });
      expect(structured.nextCursor).toBeDefined();
      const atLeast = NEXT_PAGE(1, `at least ${structured.totalCount}`);
      expect(structured.notice).toBe(atLeast);
      const rendered = contractText(result);
      expect(rendered).toContain(`> ${atLeast}`);
      expect(rendered).toContain('**Total is a lower bound:** true');
    });

    it('keeps the zero-hit notice for an exact zero', async () => {
      await useIndex(fixture.mirrorDir, {
        frequencySearch: { exactCap: 1, walkBudget: 2, windowTarget: 1 },
      });
      const result = page(await run({ frequency_low: 100 }));
      expect(result.totalCount).toBe(0);
      expect(result.totalIsLowerBound).toBeUndefined();
      expect(result.notice).toBe(
        `${ACTIVE_ONLY} No authorization overlaps 100 MHz under these filters; widen the band.`,
      );
    });
  });

  describe('notices', () => {
    it('says why a redacted name search finds nothing on an individual-held frequency', async () => {
      const result = page(await run({ frequency_low: 158.7, licensee: 'pat' }));
      expect(result).toMatchObject({ totalCount: 0, assignments: [] });
      expect(result.appliedFilters).toEqual({
        frequency_low_mhz: 158.7,
        frequency_high_mhz: 158.7,
        kind: 'both',
        licensee: 'pat',
        status: 'A',
      });
      expect(result.notice).toBe(
        `${ACTIVE_ONLY} No authorization overlaps 158.7 MHz under these filters; drop licensee or widen the band. ${NAME_SEARCH_EXCLUDES_INDIVIDUALS}`,
      );
    });

    it('finds the individual by name, with no notice, once redaction is off', async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = page(await run({ frequency_low: 158.7, licensee: 'pat' }));
      expect(result.assignments).toEqual([
        expect.objectContaining({
          usi: '1003',
          licenseeName: 'Pat Q Example',
          licenseeRedacted: false,
        }),
      ]);
      expect(result.notice).toBeUndefined();
    });

    it("withholds an individual's name on a frequency search while redacting", async () => {
      const result = await run({ frequency_low: 158.7 });
      expect(page(result).assignments).toEqual([
        expect.objectContaining({ usi: '1003', licenseeName: null, licenseeRedacted: true }),
      ]);
      const rendered = contractText(result);
      expect(rendered.split('\n')).toContain(
        '- **Licensee:** Redacted (individual licensee) · **Redacted:** yes · **Lease:** no',
      );
      expect(rendered).not.toContain('Pat Q Example');
    });

    it('keeps only the redaction fragment when a redacted name search has hits', async () => {
      const result = page(await run({ ...BRS, licensee: 'sample broadband' }));
      expect(rowIds(result.assignments)).toEqual([
        'm2001@2496',
        's2001:1@2500',
        'm2001@2502',
        's2001:2@2512',
      ]);
      expect(result.notice).toBe(NAME_SEARCH_EXCLUDES_INDIVIDUALS);
    });

    it.each([
      ['both', ['m2001@2496', 'm2002@2496', 's2001:1@2500', 'm2001@2502', 'm2004@2524']],
      ['market', ['m2001@2496', 'm2002@2496', 'm2001@2502', 'm2004@2524']],
    ])('adds the state fragment for kind %s', async (kind, expected) => {
      const result = page(await run({ ...BRS, state: 'nd', kind }));
      expect(rowIds(result.assignments)).toEqual(expected);
      expect(result.notice).toBe(STATE_FRAGMENT);
    });

    it('leaves the state fragment off for kind site', async () => {
      const result = page(await run({ ...BRS, state: 'MN', kind: 'site' }));
      expect(rowIds(result.assignments)).toEqual(['s2001:2@2512']);
      expect(result.assignments[0]).toMatchObject({ state: 'MN', stateFromCoordinates: false });
      expect(result.notice).toBeUndefined();
    });

    it('composes the state fragment and the paging guidance into one notice', async () => {
      const result = page(await run({ ...BRS, state: 'ND', limit: 2 }));
      expect(result).toMatchObject({ totalCount: 5, truncated: true, shown: 2, cap: 2 });
      expect(result.notice).toBe(`${STATE_FRAGMENT} ${NEXT_PAGE(2, 5)}`);
    });

    it('lists every option when every filter is set', async () => {
      const result = page(
        await run({ ...BRS, state: 'TX', radio_service: 'BR', licensee: 'sample', kind: 'market' }),
      );
      expect(result.totalCount).toBe(0);
      expect(result.notice).toBe(
        `${ACTIVE_ONLY} No authorization overlaps 2496–2530 MHz in TX under these filters; drop state, drop radio_service, drop licensee, widen the band, or pass kind "both". ${STATE_FRAGMENT} ${NAME_SEARCH_EXCLUDES_INDIVIDUALS}`,
      );
    });

    it.each([['any'], ['L'], ['x']])(
      'leaves the status fragment off a zero hit under status %s',
      async (status) => {
        const result = page(await run({ frequency_low: 100, status }));
        expect(result.totalCount).toBe(0);
        expect(result.notice).toBe(
          'No authorization overlaps 100 MHz under these filters; widen the band.',
        );
      },
    );

    it('finds the pending-legal record only when status allows it', async () => {
      const active = page(await run({ frequency_low: 152.24 }));
      expect(rowIds(active.assignments)).toEqual(['s1001:1@152.24']);
      const pending = page(await run({ frequency_low: 152.24, status: 'l' }));
      expect(pending.appliedFilters).toMatchObject({ status: 'L' });
      expect(rowIds(pending.assignments)).toEqual(['s1007:1@152.24']);
      const any = page(await run({ frequency_low: 152.24, status: 'any' }));
      expect(rowIds(any.assignments)).toEqual(['s1001:1@152.24', 's1007:1@152.24']);
    });
  });

  describe('registry text', () => {
    it('keeps a CR verbatim in structuredContent and flattens it in content[]', async () => {
      const result = await run({ frequency_low: 152.24, status: 'L' });
      const [row] = page(result).assignments;
      expect(row).toMatchObject({
        usi: '1007',
        callsign: 'KZZ907',
        licenseeName: 'Carriage\rReturn Paging',
        state: 'ID',
        stateFromCoordinates: false,
      });
      expect(row).not.toHaveProperty('latitude');
      expect(row).not.toHaveProperty('longitude');
      const rendered = contractText(result);
      expect(rendered).not.toContain('\r');
      const rows = rendered.split('\n');
      expect(rows).toContain(
        '- **Licensee:** Carriage Return Paging · **Redacted:** no · **Lease:** no',
      );
      expect(rows).toContain('- **Site:** location 1 · type F (Fixed) · ID (state as filed)');
    });
  });

  describe('enrichment contract (runToolContract)', () => {
    it('carries every required field and the notice on the zero-result page', async () => {
      const result = await run({ frequency_low: 100 });
      const structured = page(result);
      expect(structured).toMatchObject({
        assignments: [],
        dataAsOf: DATA_AS_OF,
        totalCount: 0,
        truncated: false,
        shown: 0,
        cap: 50,
        appliedFilters: {
          frequency_low_mhz: 100,
          frequency_high_mhz: 100,
          kind: 'both',
          status: 'A',
        },
        notice: `${ACTIVE_ONLY} No authorization overlaps 100 MHz under these filters; widen the band.`,
      });
      expect(structured.nextCursor).toBeUndefined();
      const rendered = contractText(result);
      expect(rendered).toContain('No authorizations matched.');
      expect(rendered).toContain(`**dataAsOf:** ${DATA_AS_OF}`);
      expect(rendered).toContain(
        '**Applied filters:** frequency_low_mhz=100 · frequency_high_mhz=100 · kind="both" · status="A"',
      );
      expect(rendered).toContain('**0 total**');
      expect(rendered).toContain(`> ${structured.notice}`);
    });

    it('carries every row field on an under-cap page, with no notice or cursor', async () => {
      const result = await run(BRS);
      const structured = page(result);
      expect(structured).toMatchObject({
        dataAsOf: DATA_AS_OF,
        totalCount: 6,
        truncated: false,
        shown: 6,
        cap: 50,
        appliedFilters: {
          frequency_low_mhz: 2496,
          frequency_high_mhz: 2530,
          kind: 'both',
          status: 'A',
        },
      });
      expect(structured.notice).toBeUndefined();
      expect(structured.nextCursor).toBeUndefined();
      const rendered = contractText(result);
      expectCarries(rendered, structured.assignments);
      expect(rendered).toContain('**6 total**');
      expect(rendered).toContain('**Lease:** yes');
      expect(rendered).toContain('(state derived from coordinates)');
      expect(rendered).not.toContain('nextCursor');
    });

    it('renders every value of a mixed site and paging page', async () => {
      const result = await run({ frequency_low: 152, frequency_high: 160, status: 'any' });
      const structured = page(result);
      expect(rowIds(structured.assignments)).toEqual([
        's1001:1@152.24',
        's1007:1@152.24',
        's1006:1@152.84',
        's1003:1@158.7',
      ]);
      expectCarries(contractText(result), structured.assignments);
    });
  });
});

describe('filing quirks', () => {
  const PAL_NOT_MATCHED =
    'ULS files Priority Access Licenses (radio service PL, 3550–3650 MHz) as a 10 MHz channel width with no frequency, so frequency search does not match them; list them with fcc_spectrum_search_licenses and radio_service "PL".';

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

  it('never matches a PAL block filed as 0–10 MHz, and says why on a search of the PAL band', async () => {
    expect(page(await run({ frequency_low: 5, kind: 'market' })).totalCount).toBe(0);
    const result = await run({ frequency_low: 3550, frequency_high: 3700, radio_service: 'PL' });
    const structured = page(result);
    expect(structured.totalCount).toBe(0);
    expect(structured.notice).toContain(PAL_NOT_MATCHED);
    expect(contractText(result)).toContain(PAL_NOT_MATCHED);
  });

  it('leaves the PAL notice off searches that could not match a PAL', async () => {
    for (const input of [
      { frequency_low: 3600, kind: 'site' },
      { frequency_low: 3600, radio_service: 'CW' },
      { frequency_low: 3500, frequency_high: 3549 },
      { frequency_low: 3651, frequency_high: 3700 },
    ]) {
      expect(page(await run(input)).notice ?? '', JSON.stringify(input)).not.toContain(
        'Priority Access',
      );
    }
    expect(page(await run({ frequency_low: 3.6, unit: 'GHz' })).notice).toContain(PAL_NOT_MATCHED);
  });

  it('returns a block filed under several partition areas once, listing the areas', async () => {
    const result = await run({
      frequency_low: 1757,
      kind: 'market',
      state: 'California',
      licensee: 'partitioned',
    });
    const structured = page(result);
    expect(structured.totalCount).toBe(1);
    expect(structured.assignments).toEqual([
      expect.objectContaining({
        usi: '5004',
        frequencyMhz: 1755,
        upperMhz: 1760,
        marketCode: 'CMA097',
        channelBlock: 'G',
        partitionAreaIds: [8183, 8184, 96978],
      }),
    ]);
    expect(contractText(result).split('\n')).toContain(
      '- **Market:** CMA097 — Bakersfield, CA · **Block:** G · **Partition areas:** 8183, 8184, 96978',
    );
    expectCarries(contractText(result), structured.assignments);
  });

  it("returns a frequency filed against a shared location number once, without one site's place", async () => {
    const result = await run({ frequency_low: 5900, kind: 'site', state: 'WA' });
    const structured = page(result);
    expect(structured.totalCount).toBe(1);
    const [row] = structured.assignments;
    expect(row).toMatchObject({ usi: '5005', locationNumber: 1, sitesSharingNumber: 2 });
    expect(row).not.toHaveProperty('latitude');
    expect(row).not.toHaveProperty('state');
    const rendered = contractText(result);
    expect(rendered.split('\n')).toContain(
      '- **Site:** location 1 · 2 sites share this location number; ULS does not say which uses this frequency',
    );
    expectCarries(rendered, structured.assignments);
  });
});

describe('operating areas', () => {
  let areas: FixtureIndex;
  beforeAll(async () => {
    areas = await buildFixtureIndex({ groups: ['paging'], weekly: { paging: AREA_SITES_WEEKLY } });
  });
  beforeEach(async () => {
    await useIndex(areas.mirrorDir, { services: ['paging'] });
  });
  afterAll(async () => {
    await releaseIndex();
    await areas.dispose();
  });

  it("carries a single site's location type and radius on both surfaces", async () => {
    const result = await run({ frequency_low: 456.0125, kind: 'site', state: 'WA' });
    const structured = page(result);
    expect(structured.totalCount).toBe(1);
    const [row] = structured.assignments;
    expect(row).toMatchObject({
      usi: '5301',
      locationNumber: 2,
      locationTypeCode: 'M',
      locationTypeLabel: 'Mobile',
      radiusKm: 4,
      longitude: -119,
    });
    const rendered = contractText(result);
    expectCarries(rendered, structured.assignments);
    expect(rendered.split('\n')).toContain(
      `- **Site:** location 2 · type M (Mobile) · ${row?.latitude}, -119 · radius of operation 4 km · WA (state as filed)`,
    );
  });

  it('renders a fixed site with no radius and an untyped site without inventing either', async () => {
    const result = await run({ frequency_low: 451, frequency_high: 454, kind: 'site' });
    const structured = page(result);
    expect(rowIds(structured.assignments)).toEqual([
      's5301:1@451.0125',
      's5301:4@452.5',
      's5301:5@453.5',
    ]);
    const [fixed, fixedWithRadius, untyped] = structured.assignments;
    expect(fixed).not.toHaveProperty('radiusKm');
    expect(fixedWithRadius).toMatchObject({ locationTypeCode: 'F', radiusKm: 1.5 });
    for (const field of ['locationTypeCode', 'locationTypeLabel', 'radiusKm']) {
      expect(untyped).not.toHaveProperty(field);
    }
    const rows = contractText(result).split('\n');
    expect(rows).toContain(
      '- **Site:** location 1 · type F (Fixed) · 46, -119 · BENTON, WA (state as filed)',
    );
    expect(rows).toContain(
      `- **Site:** location 5 · ${untyped?.latitude}, -119 · WA (state as filed)`,
    );
    expectCarries(contractText(result), structured.assignments);
  });

  it('gives a shared location number no type or radius, as it gives no coordinates', async () => {
    const result = await run({ frequency_low: 458.5, kind: 'site' });
    const [row] = page(result).assignments;
    expect(row).toMatchObject({ locationNumber: 6, sitesSharingNumber: 2 });
    for (const field of ['latitude', 'locationTypeCode', 'locationTypeLabel', 'radiusKm']) {
      expect(row).not.toHaveProperty(field);
    }
    expect(contractText(result).split('\n')).toContain(
      '- **Site:** location 6 · 2 sites share this location number; ULS does not say which uses this frequency',
    );
  });
});

describe('market areas by state', () => {
  let markets: FixtureIndex;
  beforeAll(async () => {
    markets = await buildFixtureIndex({
      groups: ['paging'],
      weekly: { paging: MARKET_STATES_WEEKLY },
    });
  });
  beforeEach(async () => {
    await useIndex(markets.mirrorDir, { services: ['paging'] });
  });
  afterAll(async () => {
    await releaseIndex();
    await markets.dispose();
  });

  /** The 704–710 MHz market blocks, one per license (USIs 7001–7010). */
  const MARKET = { frequency_low: 705, kind: 'market' };

  it('matches market areas that name no state in each state they reach, on both surfaces', async () => {
    const result = await run({ ...MARKET, state: 'pennsylvania' });
    const structured = page(result);
    expect(structured).toMatchObject({
      totalCount: 2,
      truncated: false,
      shown: 2,
      appliedFilters: { state: 'PA', kind: 'market' },
      notice: STATE_FRAGMENT,
    });
    expect(structured.assignments.map((row) => [row.usi, row.marketCode, row.marketName])).toEqual([
      ['7001', 'MTA010', 'Washington-Baltimore'],
      ['7002', 'BEA010', 'New York-No. New Jer.-Long Isl'],
    ]);
    const rendered = contractText(result);
    expectCarries(rendered, structured.assignments);
    expect(rendered).toContain(`> ${STATE_FRAGMENT}`);
  });

  it('pages a state past its first page and composes the rule with the paging guidance', async () => {
    const first = page(await run({ ...MARKET, state: 'PA', limit: 1 }));
    expect(first).toMatchObject({ totalCount: 2, truncated: true, shown: 1, cap: 1 });
    expect(first.notice).toBe(`${STATE_FRAGMENT} ${NEXT_PAGE(1, 2)}`);
    expect(rowIds(first.assignments)).toEqual(['m7001@704']);
    const second = page(await run({ ...MARKET, state: 'PA', limit: 1, cursor: first.nextCursor }));
    expect(second).toMatchObject({ totalCount: 2, truncated: false, shown: 1 });
    expect(rowIds(second.assignments)).toEqual(['m7002@704']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('returns an empty page for a cursor past the last match', async () => {
    const result = page(
      await run({
        ...MARKET,
        state: 'PA',
        cursor: forgeCursor(FIXTURE_GENERATION_ID, 'f', 704, 0, 9999, 0, 710),
      }),
    );
    expect(result).toMatchObject({ totalCount: 2, shown: 0, truncated: false });
    expect(result.assignments).toEqual([]);
  });

  it('finds nothing in a state only Gulf of Mexico and nationwide filings touch', async () => {
    const result = page(await run({ ...MARKET, state: 'LA' }));
    expect(result).toMatchObject({ totalCount: 0, shown: 0, truncated: false });
    expect(result.notice).toBe(
      `${ACTIVE_ONLY} No authorization overlaps 705 MHz in LA under these filters; drop state, widen the band, or pass kind "both". ${STATE_FRAGMENT}`,
    );
  });

  it('reaches a market the state rule skips through market_code', async () => {
    const result = page(await run({ ...MARKET, market_code: 'tl4' }));
    expect(result).toMatchObject({ totalCount: 1, appliedFilters: { market_code: 'TL0004' } });
    expect(rowIds(result.assignments)).toEqual(['m7006@704']);
  });
});

describe('market code and FRN filters', () => {
  let markets: FixtureIndex;
  beforeAll(async () => {
    markets = await buildFixtureIndex({
      groups: ['paging'],
      weekly: { paging: MARKET_CODES_WEEKLY },
    });
  });
  beforeEach(async () => {
    await useIndex(markets.mirrorDir, { services: ['paging'] });
  });
  afterAll(async () => {
    await releaseIndex();
    await markets.dispose();
  });

  /** 704–710 MHz: the 700 MHz blocks of USIs 8003–8008 and KZZ803's 709 MHz site. */
  const UPPER_700 = { frequency_low: 704, frequency_high: 710 };
  /** 824–894 MHz: the cellular sites of KZZ801 and KZZ802. */
  const CELLULAR = { frequency_low: 824, frequency_high: 894 };

  it('filters both row kinds by the license market code, on both surfaces', async () => {
    const result = await run({ ...UPPER_700, market_code: 'pea16' });
    const structured = page(result);
    expect(structured).toMatchObject({
      totalCount: 3,
      shown: 3,
      truncated: false,
      appliedFilters: { market_code: 'PEA016', kind: 'both' },
    });
    expect(rowIds(structured.assignments)).toEqual(['m8003@704', 'm8004@704', 's8003:1@709']);
    expect(structured.notice).toBeUndefined();
    const rendered = contractText(result);
    expect(rendered).toContain('market_code="PEA016"');
    expectCarries(rendered, structured.assignments);
  });

  it('keeps two codes apart, against the unfiltered band', async () => {
    const all = page(await run(UPPER_700));
    expect(rowIds(all.assignments)).toEqual([
      'm8003@704',
      'm8004@704',
      'm8005@704',
      'm8007@704',
      'm8008@704',
      's8003:1@709',
    ]);
    expect(rowIds(page(await run({ ...UPPER_700, market_code: 'PEA017' })).assignments)).toEqual([
      'm8005@704',
    ]);
    expect(rowIds(page(await run({ ...UPPER_700, market_code: 'nw' })).assignments)).toEqual([
      'm8007@704',
    ]);
  });

  it('returns the site rows of a cellular market code, and no market rows', async () => {
    const sites = page(await run({ ...CELLULAR, market_code: 'CMA020' }));
    expect(rowIds(sites.assignments)).toEqual([
      's8001:1@869.04',
      's8002:1@870.03',
      's8001:1@880.02',
    ]);
    const blocks = page(await run({ ...CELLULAR, market_code: 'CMA020', kind: 'market' }));
    expect(blocks).toMatchObject({ totalCount: 0, assignments: [] });
    expect(blocks.notice).toBe(
      `${ACTIVE_ONLY} No authorization overlaps 824–894 MHz under these filters; drop market_code, widen the band, or pass kind "both". ${CODE_SOURCE}`,
    );
  });

  it('applies state and market_code together, judging market rows by the state rule', async () => {
    const wa = page(await run({ ...UPPER_700, market_code: 'PEA016', state: 'WA' }));
    expect(rowIds(wa.assignments)).toEqual(['m8003@704', 'm8004@704', 's8003:1@709']);
    expect(wa.notice).toBe(MARKET_STATE_RULE);
    const oregon = page(await run({ ...UPPER_700, market_code: 'PEA016', state: 'OR' }));
    expect(oregon.totalCount).toBe(0);
    expect(oregon.notice).toBe(
      `${ACTIVE_ONLY} No authorization overlaps 704–710 MHz in OR under these filters; drop state, drop market_code, or widen the band. ${CODE_SOURCE} ${MARKET_STATE_RULE}`,
    );
    const minnesota = page(await run({ ...UPPER_700, market_code: 'PEA017', state: 'MN' }));
    expect(rowIds(minnesota.assignments)).toEqual(['m8005@704']);
    const cellularWa = page(
      await run({ ...CELLULAR, market_code: 'CMA020', state: 'WA', kind: 'site' }),
    );
    expect(cellularWa.totalCount).toBe(3);
  });

  it('filters by FRN, normalized, returning an individual redacted', async () => {
    const company = page(await run({ ...UPPER_700, frn: '800-003' }));
    expect(company.appliedFilters).toMatchObject({ frn: '0000800003' });
    expect(rowIds(company.assignments)).toEqual(['m8003@704', 'm8005@704', 's8003:1@709']);
    const result = await run({ ...UPPER_700, frn: '800004' });
    const individual = page(result);
    expect(rowIds(individual.assignments)).toEqual(['m8004@704']);
    expect(individual.assignments[0]).toMatchObject({
      licenseeName: null,
      licenseeRedacted: true,
    });
    expect(contractText(result)).toContain('Redacted (individual licensee)');
    expect(contractText(result)).not.toContain('Jane');
    const both = page(await run({ ...UPPER_700, frn: '800003', market_code: 'PEA017' }));
    expect(rowIds(both.assignments)).toEqual(['m8005@704']);
  });

  it('pages a market-code search past its first page', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 3; call++) {
      const next = page(
        await run({ ...UPPER_700, market_code: 'PEA016', limit: 1, ...(cursor && { cursor }) }),
      );
      expect(next).toMatchObject({ totalCount: 3, shown: 1 });
      seen.push(...rowIds(next.assignments));
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(['m8003@704', 'm8004@704', 's8003:1@709']);
    expect(cursor).toBeUndefined();
  });

  it('says where codes come from when a well-formed code matches nothing', async () => {
    const result = await run({ ...UPPER_700, market_code: 'PEA999', frn: '800003' });
    const structured = page(result);
    expect(structured).toMatchObject({ totalCount: 0, shown: 0, assignments: [] });
    expect(structured.notice).toBe(
      `${ACTIVE_ONLY} No authorization overlaps 704–710 MHz under these filters; drop market_code, drop frn, or widen the band. ${CODE_SOURCE}`,
    );
    expect(contractText(result)).toContain(CODE_SOURCE);
  });

  it('reads blank market_code and frn as unset', async () => {
    const blank = page(await run({ ...UPPER_700, market_code: '  ', frn: '' }));
    expect(blank.appliedFilters).not.toHaveProperty('market_code');
    expect(blank.appliedFilters).not.toHaveProperty('frn');
    expect(blank.totalCount).toBe(6);
  });

  it.each([
    ['market_code', 'Seattle'],
    ['market_code', 'PEA0016'],
    ['frn', 'abc'],
    ['frn', '12345678901'],
  ])('rejects %s %s with InvalidParams', async (key, value) => {
    const error = errorOf(await run({ ...UPPER_700, [key]: value }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toContain(`${key}: Invalid string: must match pattern`);
  });
});

describe('format()', () => {
  const site: Assignment = {
    kind: 'site',
    usi: '77',
    callsign: 'KZZ\r\n077',
    isLease: false,
    licenseStatus: 'A',
    radioServiceCode: 'CD',
    radioServiceLabel: 'Paging\r\nand Radiotelephone',
    licenseeName: 'Acme\r\nRadio\nCo',
    licenseeRedacted: false,
    frequencyMhz: 152.24,
    bandwidthMhz: 0.0112,
    stationClasses: ['FB|2', 'FX\\O'],
    maxErpW: 250,
    emissions: ['11K2F3E', '10|M0'],
    locationNumber: 1,
    locationTypeCode: 'F',
    locationTypeLabel: 'Fixed',
    latitude: 47.5,
    longitude: -122.25,
    radiusKm: 2.5,
    county: 'KI\r\nNG',
    state: 'WA',
    stateFromCoordinates: false,
  };
  const market: Assignment = {
    kind: 'market',
    usi: '2002',
    callsign: 'L000\r\n000001',
    isLease: true,
    licenseStatus: 'A',
    radioServiceCode: 'BR',
    radioServiceLabel: 'Broadband Radio Service',
    licenseeName: 'Lease\rholder Wireless',
    licenseeRedacted: false,
    frequencyMhz: 2496,
    upperMhz: 2502,
    marketCode: 'BTA138',
    marketName: 'Fargo\r\nMoorhead, ND-MN',
    channelBlock: 'A\n1',
  };

  it('flattens CR/LF in every registry text slot so each stays on its line', () => {
    const rendered = formattedText(searchFrequencies.format?.({ assignments: [site, market] }));
    expect(rendered).not.toContain('\r');
    const rows = rendered.split('\n');
    for (const line of [
      '## Frequency authorizations (2 on this page)',
      '### 152.24 MHz · site · KZZ 077 · USI 77',
      '- **Licensee:** Acme Radio Co · **Redacted:** no · **Lease:** no',
      '- **Status:** A · **Service:** CD (Paging and Radiotelephone)',
      '- **Site:** location 1 · type F (Fixed) · 47.5, -122.25 · radius of operation 2.5 km · KI NG, WA (state as filed)',
      '### 2496–2502 MHz · market · L000 000001 · USI 2002',
      '- **Licensee:** Lease holder Wireless · **Redacted:** no · **Lease:** yes',
      '- **Status:** A · **Service:** BR (Broadband Radio Service)',
      '- **Market:** BTA138 — Fargo Moorhead, ND-MN · **Block:** A 1',
    ]) {
      expect(rows).toContain(line);
    }
    expect(rows.filter((line) => line.startsWith('- **Site:**'))).toHaveLength(1);
    expect(rows.filter((line) => line.startsWith('- **Market:**'))).toHaveLength(1);
    expectCarries(rendered, { ...site, stationClasses: [], emissions: [] });
    expectCarries(rendered, market);
  });

  it('escapes | and \\ in the station-class and emission values', () => {
    const rendered = formattedText(searchFrequencies.format?.({ assignments: [site] }));
    expect(rendered.split('\n')).toContain(
      '- **Bandwidth:** 0.0112 MHz · **Station classes:** FB\\|2, FX\\\\O · **Max ERP:** 250 W · **Emissions:** 11K2F3E, 10\\|M0',
    );
  });

  it('renders sparse rows without inventing values', () => {
    const bareSite: Assignment = {
      kind: 'site',
      usi: '78',
      isLease: false,
      licenseStatus: 'X',
      radioServiceCode: 'ZQ',
      radioServiceLabel: 'ZQ',
      licenseeName: null,
      licenseeRedacted: false,
      frequencyMhz: 929.5,
      stationClasses: [],
      emissions: [],
      locationNumber: 2,
    };
    const bareMarket: Assignment = {
      kind: 'market',
      usi: '79',
      isLease: false,
      licenseStatus: 'A',
      radioServiceCode: 'BR',
      radioServiceLabel: 'Broadband Radio Service',
      licenseeName: null,
      licenseeRedacted: true,
      frequencyMhz: 2618,
      upperMhz: 2618,
    };
    const rendered = formattedText(
      searchFrequencies.format?.({ assignments: [bareSite, bareMarket], nextCursor: 'abc_DEF-1' }),
    );
    const rows = rendered.split('\n');
    expect(rows).toContain('### 929.5 MHz · site · (no callsign) · USI 78');
    expect(rows).toContain('- **Licensee:** Not on file · **Redacted:** no · **Lease:** no');
    expect(rows).toContain('- **Site:** location 2');
    expect(rows).toContain('### 2618 MHz · market · (no callsign) · USI 79');
    expect(rows).toContain(
      '- **Licensee:** Redacted (individual licensee) · **Redacted:** yes · **Lease:** no',
    );
    expect(rendered).not.toContain('radius of operation');
    expect(rendered).not.toContain('**Bandwidth:**');
    expect(rendered).not.toContain('**Station classes:**');
    expect(rendered).not.toContain('**Market:**');
    expect(rendered.endsWith('**nextCursor:** abc_DEF-1')).toBe(true);
  });

  it('says so when nothing matched', () => {
    expect(formattedText(searchFrequencies.format?.({ assignments: [] }))).toBe(
      '## Frequency authorizations (0 on this page)\n\nNo authorizations matched.',
    );
  });
});
