/**
 * @fileoverview Tests for `fcc_spectrum_search_licenses` over the fixture index: the cold
 * and dangling-pointer index, every declared error reason on both surfaces, input
 * normalization and blank optional inputs, truncation disclosure and cursor paging, the
 * zero-hit and redaction notices, the required enrichment on the zero-result and under-cap
 * pages, and `format()` parity with registry text carrying CR/LF and `|`.
 * @module tests/tools/search-licenses.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchLicenses } from '@/mcp-server/tools/definitions/search-licenses.tool.js';
import { LICENSE_STATUSES } from '@/services/uls/codes.js';
import { writePointer } from '@/services/uls/schema.js';
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
import { carrierNamesWeekly } from '../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

type Output = Awaited<ReturnType<typeof searchLicenses.handler>>;
type License = Output['licenses'][number];
type Page = Output & PageEnrichment;

const DATA_AS_OF = '2026-09-27T13:44:10Z';

/** Every CD (paging) record in callsign-then-USI order, status any. */
const PAGING_ORDER = ['1001', '1005', '1002', '1003', '1006', '1007', '1009'];

const ACTIVE_ONLY =
  'Only active records were searched; pass status "any" to include expired, cancelled, and terminated licenses.';
const NAME_SEARCH_EXCLUDES_INDIVIDUALS =
  'Individual licensees are excluded from name search while redaction is on; search by callsign or frn instead.';

const run = (input: Record<string, unknown>) => runToolContract(searchLicenses, input as never);

const page = (result: ContractResult) => successOf<Page>(result);
const usis = (licenses: readonly License[]) => licenses.map((license) => license.usi);

describe('cold index', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('search-licenses-cold');
  });
  afterAll(async () => {
    await releaseIndex();
    await cold.remove();
  });

  it.each([
    ['a callsign search', { callsign: 'KZZ901' }],
    ['a search with no criteria', { status: 'any' }],
  ])('fails %s with index_not_ready before any other check', async (_label, input) => {
    await useIndex(cold.mirrorDir);
    const error = expectDeclaredError(searchLicenses, await run(input), 'index_not_ready');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.retryable).toBe(false);
    expect(contractText(await run(input))).toContain('not retryable');
  });

  it('fails with index_not_ready when current.json names a missing generation', async () => {
    const dangling = await makeTempMirror('search-licenses-dangling');
    try {
      await writePointer(dangling.mirrorDir, {
        file: 'fcc-uls-20990101T000000Z.db',
        publishedAt: '2026-09-29T20:00:00Z',
      });
      await useIndex(dangling.mirrorDir);
      expectDeclaredError(searchLicenses, await run({ callsign: 'KZZ901' }), 'index_not_ready');
    } finally {
      await releaseIndex();
      await dangling.remove();
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
      ['only status and limit', { status: 'any', limit: 5 }],
      [
        'every criterion blank',
        { callsign: '', licensee: '   ', frn: ' ', radio_service: '', state: '', status: '' },
      ],
    ])('fails no_criteria with %s', async (_label, input) => {
      const error = expectDeclaredError(searchLicenses, await run(input), 'no_criteria');
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('fails unknown_radio_service for a code neither the table nor the index holds', async () => {
      const error = expectDeclaredError(
        searchLicenses,
        await run({ radio_service: ' q9 ' }),
        'unknown_radio_service',
      );
      expect(error.message).toBe('"Q9" is not a ULS radio service code.');
      expect(error.data?.radioService).toBe('Q9');
    });

    it('fails service_not_indexed for a known code no indexed group carries', async () => {
      const error = expectDeclaredError(
        searchLicenses,
        await run({ radio_service: 'CL' }),
        'service_not_indexed',
      );
      expect(error.message).toBe(
        'Radio service CL (Cellular) is not in any service group this deployment indexes (paging, mdsitfs, amat).',
      );
      expect(error.data?.radioService).toBe('CL');
    });

    it.each([
      ['a cursor that does not decode', 'garbage'],
      ['a cursor from another generation', forgeCursor('20990101T000000Z', 'c', 'KZZ901', 1001)],
      ['a find_transmitters cursor', forgeCursor(FIXTURE_GENERATION_ID, 't', 0, 1001, 1, 1)],
      [
        'a name-search cursor on a callsign search',
        forgeCursor(FIXTURE_GENERATION_ID, 'r', -1, 1001),
      ],
    ])('fails invalid_cursor for %s', async (_label, cursor) => {
      expectDeclaredError(
        searchLicenses,
        await run({ radio_service: 'CD', cursor }),
        'invalid_cursor',
      );
    });

    it.each([
      ['limit 0', { callsign: 'KZZ901', limit: 0 }],
      ['limit 101', { callsign: 'KZZ901', limit: 101 }],
      ['a prefix-portable callsign', { callsign: 'VE3/N0CALL' }],
      ['a prefix-portable callsign with a 4-character base', { callsign: 'KL7/AA0A' }],
      ['an 11-digit FRN', { frn: '12345678901' }],
      ['an unknown state name', { state: 'Atlantis' }],
      ['an unknown status', { callsign: 'KZZ901', status: 'Q' }],
      ['a three-character service code', { radio_service: 'ABC' }],
      ['a 201-character licensee', { licensee: 'x'.repeat(201) }],
      ['a licensee with no letter or digit', { licensee: ' !!! ' }],
      ['a punctuation-only licensee with a bad cursor', { licensee: '&-.', cursor: 'bad' }],
      ['a cursor with spaces', { callsign: 'KZZ901', cursor: 'has space' }],
      ['a status word that names two statuses', { callsign: 'KZZ901', status: 'pending' }],
    ])('rejects %s with InvalidParams', async (_label, input) => {
      const error = errorOf(await run(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
    });

    it('names the rule when licensee has nothing searchable', () => {
      const parsed = searchLicenses.input.safeParse({ licensee: '!!!' });
      expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
        'licensee needs at least one letter or digit; punctuation alone has nothing to search.',
      ]);
    });
  });

  describe('inputs', () => {
    it('echoes normalized callsign and status in appliedFilters', async () => {
      const result = page(await run({ callsign: ' kzz901/4 ', status: 'ANY' }));
      expect(result.appliedFilters).toEqual({ callsign: 'KZZ901', status: 'any' });
      expect(usis(result.licenses)).toEqual(['1001', '1005']);
    });

    it('reads a spelled-out status as its code', async () => {
      const result = page(await run({ callsign: 'KZZ901', status: ' Expired ' }));
      expect(result.appliedFilters).toEqual({ callsign: 'KZZ901', status: 'E' });
      expect(usis(result.licenses)).toEqual(['1005']);
    });

    it('describes each status code with the label it renders', () => {
      const described = searchLicenses.input.shape.status.description;
      for (const [code, label] of Object.entries(LICENSE_STATUSES)) {
        expect(described).toContain(`${code} ${label.toLowerCase().replace(/ status$/, '')}`);
      }
      expect(
        searchLicenses.output.shape.licenses.element.shape.licenseStatus.description,
      ).toContain('C canceled');
    });

    it('echoes a padded FRN, a state name as its code, and the default status', async () => {
      const result = page(await run({ frn: '123-4567', state: 'washington' }));
      expect(result.appliedFilters).toEqual({ frn: '0001234567', status: 'A', state: 'WA' });
      expect(usis(result.licenses)).toEqual(['1001']);
    });

    it('reads blank optional inputs as unset', async () => {
      const input = {
        callsign: 'KZZ901',
        licensee: '',
        frn: '  ',
        radio_service: '',
        state: ' ',
        status: '',
        cursor: '',
      };
      const parsed = searchLicenses.input.parse(input);
      expect(parsed).toMatchObject({ callsign: 'KZZ901', status: 'A', limit: 25 });
      for (const key of ['licensee', 'frn', 'radio_service', 'state', 'cursor'] as const) {
        expect(parsed[key]).toBeUndefined();
      }
      const result = page(await run(input));
      expect(result.appliedFilters).toEqual({ callsign: 'KZZ901', status: 'A' });
      expect(usis(result.licenses)).toEqual(['1001']);
      expect(result.notice).toBeUndefined();
    });

    it('accepts an index-observed code the FCC table lacks', async () => {
      const result = page(await run({ radio_service: 'zq' }));
      expect(result.appliedFilters).toEqual({ radio_service: 'ZQ', status: 'A' });
      expect(result.licenses).toEqual([
        expect.objectContaining({ usi: '1008', radioServiceCode: 'ZQ', radioServiceLabel: 'ZQ' }),
      ]);
    });
  });

  describe('paging', () => {
    it('discloses truncation and follows the cursor to the last page', async () => {
      const first = await run({ radio_service: 'CD', status: 'any', limit: 3 });
      const one = page(first);
      expect(one).toMatchObject({ totalCount: 7, truncated: true, shown: 3, cap: 3 });
      const notice =
        'Showing 3 of 7 records; pass nextCursor as cursor with the same filters for the next page.';
      expect(one.notice).toBe(notice);
      expect(one.nextCursor).toEqual(expect.any(String));
      const rendered = contractText(first);
      expect(rendered).toContain(`**nextCursor:** ${one.nextCursor}`);
      expect(rendered).toContain(`> ${notice}`);
      expect(rendered).toContain('**truncated:** true');

      const two = page(
        await run({ radio_service: 'CD', status: 'any', limit: 3, cursor: one.nextCursor }),
      );
      expect(two).toMatchObject({ totalCount: 7, truncated: true, shown: 3 });
      const three = page(
        await run({ radio_service: 'CD', status: 'any', limit: 3, cursor: two.nextCursor }),
      );
      expect(three).toMatchObject({ totalCount: 7, truncated: false, shown: 1, cap: 3 });
      expect(three.nextCursor).toBeUndefined();
      expect(three.notice).toBeUndefined();
      expect([...usis(one.licenses), ...usis(two.licenses), ...usis(three.licenses)]).toEqual(
        PAGING_ORDER,
      );
    });

    it('pages a name search in rank order without repeats, keeping the redaction notice', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = page(
          await run({ licensee: 'paging', status: 'any', limit: 2, ...(cursor && { cursor }) }),
        );
        pages++;
        expect(result.totalCount).toBe(4);
        expect(result.notice?.startsWith(NAME_SEARCH_EXCLUDES_INDIVIDUALS)).toBe(true);
        seen.push(...usis(result.licenses));
        cursor = result.nextCursor;
      } while (cursor);
      expect(pages).toBe(2);
      expect(seen).toHaveLength(4);
      expect(new Set(seen)).toEqual(new Set(['1001', '1005', '1006', '1007']));
    });
  });

  describe('notices', () => {
    it('explains a zero-hit callsign search under the default status', async () => {
      const result = page(await run({ callsign: 'KZZ000' }));
      expect(result.notice).toBe(
        `${ACTIVE_ONLY} No record carries callsign KZZ000 in the indexed service groups; call fcc_spectrum_get_license with this callsign, which reads every status, or fcc_spectrum_list_reference with topic "coverage" to confirm the service group is loaded.`,
      );
    });

    it('names a non-default status and the FRN on a zero-hit FRN search', async () => {
      const result = page(await run({ frn: '9999999', status: 'e' }));
      expect(result.appliedFilters).toEqual({ frn: '0009999999', status: 'E' });
      expect(result.notice).toBe(
        'Only status E records were searched; pass status "any" to search every status. No record matching these filters carries FRN 0009999999; some licensees file no FRN, so also search by licensee name.',
      );
    });

    it('points a zero-hit state search at the site-location tools, with no status fragment under "any"', async () => {
      const result = page(await run({ state: 'TX', status: 'any' }));
      expect(result.notice).toBe(
        "state matches the licensee's mailing address; call fcc_spectrum_search_frequencies or fcc_spectrum_find_transmitters to search by site location.",
      );
    });

    it('says individuals are excluded when a redacted name search finds nothing', async () => {
      const result = page(await run({ licensee: 'pat', status: 'any' }));
      expect(result.totalCount).toBe(0);
      expect(result.notice).toBe(
        `${NAME_SEARCH_EXCLUDES_INDIVIDUALS} Name matching requires every word; drop a word or search by frn.`,
      );
    });

    it('keeps only the redaction fragment when a redacted name search has hits', async () => {
      const result = page(await run({ licensee: 'sample', status: 'any' }));
      expect(new Set(usis(result.licenses))).toEqual(new Set(['2001', '3002']));
      expect(result.notice).toBe(NAME_SEARCH_EXCLUDES_INDIVIDUALS);
    });

    it('finds the individual by name, with no notice, once redaction is off', async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = page(await run({ licensee: 'pat', status: 'any' }));
      expect(result.licenses).toEqual([
        expect.objectContaining({ usi: '1003', licenseeName: 'Pat Q Example' }),
      ]);
      expect(result.notice).toBeUndefined();
    });
  });

  describe('redaction', () => {
    it("withholds an individual's name and city on a callsign lookup", async () => {
      const result = await run({ callsign: 'KZZ903' });
      const [license] = page(result).licenses;
      expect(license).toMatchObject({
        usi: '1003',
        licenseeName: null,
        licenseeRedacted: true,
        applicantType: 'I',
        licenseeState: 'WA',
      });
      expect(license).not.toHaveProperty('licenseeCity');
      const rendered = contractText(result);
      expect(rendered.split('\n')).toContain(
        '- **Licensee:** Redacted (individual licensee) · **Redacted:** yes · **FRN:** 0005550001 · **Applicant type:** I',
      );
      expect(rendered).not.toContain('(redacted)');
      expect(rendered).not.toContain('Pat Q Example');
      expect(rendered).not.toContain('SPOKANE');
    });

    it('shows the name and city with redaction off', async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = await run({ callsign: 'KZZ903' });
      expect(page(result).licenses[0]).toMatchObject({
        licenseeName: 'Pat Q Example',
        licenseeRedacted: false,
        licenseeCity: 'SPOKANE',
      });
      expect(contractText(result)).toContain('- **Licensee address:** SPOKANE, WA');
    });
  });

  describe('enrichment contract (runToolContract)', () => {
    it('carries every required field and the notice on the zero-result page', async () => {
      const result = await run({ callsign: 'KZZ000' });
      const structured = page(result);
      expect(structured).toMatchObject({
        licenses: [],
        dataAsOf: DATA_AS_OF,
        totalCount: 0,
        truncated: false,
        shown: 0,
        cap: 25,
        appliedFilters: { callsign: 'KZZ000', status: 'A' },
      });
      expect(structured.nextCursor).toBeUndefined();
      const rendered = contractText(result);
      expect(rendered).toContain('No records matched.');
      expect(rendered).toContain(`**dataAsOf:** ${DATA_AS_OF}`);
      expect(rendered).toContain('**Applied filters:** callsign="KZZ000" · status="A"');
      expect(rendered).toContain('**0 total**');
      expect(rendered).toContain(`> ${structured.notice}`);
    });

    it('carries every record field on an under-cap page, with no notice or cursor', async () => {
      const result = await run({ callsign: 'KZZ901', status: 'any' });
      const structured = page(result);
      expect(structured).toMatchObject({
        dataAsOf: DATA_AS_OF,
        totalCount: 2,
        truncated: false,
        shown: 2,
        cap: 25,
        appliedFilters: { callsign: 'KZZ901', status: 'any' },
      });
      expect(structured.notice).toBeUndefined();
      expect(structured.nextCursor).toBeUndefined();
      const rendered = contractText(result);
      expectCarries(rendered, structured.licenses);
      expect(rendered).toContain('**Lease:** no');
      expect(rendered).toContain('**2 total**');
      expect(rendered).not.toContain('nextCursor');
    });

    it('labels a lease and a record filed without a callsign', async () => {
      const result = await run({ state: 'ND', status: 'any' });
      const structured = page(result);
      const rendered = contractText(result);
      expectCarries(rendered, structured.licenses);
      expect(structured.licenses.find((license) => license.usi === '2007')).not.toHaveProperty(
        'callsign',
      );
      expect(rendered).toContain('### (no callsign) · USI 2007');
      expect(structured.licenses.find((license) => license.usi === '2004')?.isLease).toBe(true);
      expect(rendered).toContain('### L000000002 · USI 2004');
      expect(rendered).toMatch(/### L000000002 · USI 2004\n[^\n]*\n[^\n]*\*\*Lease:\*\* yes/);
    });
  });

  describe('format()', () => {
    it('keeps a CR in a fixture licensee name verbatim in structuredContent and off the line', async () => {
      const result = await run({ callsign: 'KZZ907', status: 'any' });
      expect(page(result).licenses[0]?.licenseeName).toBe('Carriage\rReturn Paging');
      const rendered = contractText(result);
      expect(rendered).toContain(
        '- **Licensee:** Carriage Return Paging · **Redacted:** no · **FRN:** 0002223333',
      );
      expect(rendered).not.toContain('\r');
    });

    it('flattens CR/LF in every registry text slot and keeps a pipe on its line', () => {
      const license: License = {
        usi: '77',
        callsign: 'KZZ077',
        isLease: false,
        licenseStatus: 'A',
        statusLabel: 'Active',
        radioServiceCode: 'CD',
        radioServiceLabel: 'Paging\r\nand Radiotelephone',
        serviceGroup: 'paging',
        licenseeName: 'Acme\r\nRadio | Relay\nCo',
        licenseeRedacted: false,
        licenseeCity: 'NEW\rYORK',
        licenseeState: 'NY',
        locationCount: 1,
        frequencyCount: 2,
        marketCode: 'BTA001',
        marketName: 'Fargo\r\nMoorhead, ND-MN',
      };
      const rendered = formattedText(searchLicenses.format?.({ licenses: [license] }));
      expect(rendered).not.toMatch(/\r/);
      const lines = rendered.split('\n');
      expect(lines).toContain('- **Licensee:** Acme Radio | Relay Co · **Redacted:** no');
      expect(lines).toContain(
        '- **Status:** A (Active) · **Service:** CD (Paging and Radiotelephone) · **Group:** paging · **Lease:** no',
      );
      expect(lines).toContain('- **Licensee address:** NEW YORK, NY');
      expect(lines).toContain('- **Market:** BTA001 — Fargo Moorhead, ND-MN');
      expect(
        rendered.startsWith('## FCC ULS licenses (1 on this page)\n\n### KZZ077 · USI 77\n'),
      ).toBe(true);
    });

    it('distinguishes a licensee ULS never filed from a redacted one', () => {
      const base: License = {
        usi: '78',
        isLease: true,
        licenseStatus: 'A',
        statusLabel: 'Active',
        radioServiceCode: 'BR',
        radioServiceLabel: 'Broadband Radio Service',
        serviceGroup: 'mdsitfs',
        licenseeName: null,
        licenseeRedacted: false,
        locationCount: 0,
        frequencyCount: 0,
      };
      const rendered = formattedText(
        searchLicenses.format?.({
          licenses: [base, { ...base, usi: '79', licenseeRedacted: true }],
          nextCursor: 'abc_DEF-1',
        }),
      );
      expect(rendered).toContain(
        '### (no callsign) · USI 78\n- **Licensee:** Not on file · **Redacted:** no\n',
      );
      expect(rendered).toContain(
        '### (no callsign) · USI 79\n- **Licensee:** Redacted (individual licensee) · **Redacted:** yes\n',
      );
      expect(rendered).toContain('**Lease:** yes');
      expect(rendered.endsWith('**nextCursor:** abc_DEF-1')).toBe(true);
    });
  });
});

describe('licensee names joined by - or &', () => {
  let carriers: FixtureIndex;
  beforeAll(async () => {
    carriers = await buildFixtureIndex({ weekly: { paging: carrierNamesWeekly() } });
  });
  beforeEach(async () => {
    await useIndex(carriers.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await carriers.dispose();
  });

  it.each([
    ['T-Mobile', ['6001']],
    ['t-mobile license', ['6001']],
    ['AT&T', ['6004']],
    ['AT & T', ['6004']],
    ['T Mobile', ['6001']],
  ])('matches %s as joined words, not one-letter prefixes', async (licensee, expected) => {
    const result = page(await run({ licensee }));
    expect(usis(result.licenses)).toEqual(expected);
    expect(result.totalCount).toBe(expected.length);
  });

  it('still matches a plain multi-word name as word prefixes in any order', async () => {
    const result = page(await run({ licensee: 'acme wire' }));
    expect(new Set(usis(result.licenses))).toEqual(new Set(['6006', '6007']));
  });
});
