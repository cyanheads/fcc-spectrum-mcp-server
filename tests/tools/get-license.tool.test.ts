/**
 * @fileoverview Tests for `fcc_spectrum_get_license` over the fixture index: the cold,
 * dangling, and malformed pointer states, `identifier_required` for every way of passing
 * neither or both identifiers, input normalization and blank inputs, hits and misses by
 * callsign and USI, the `max_frequencies` cap and its 1000-row ceiling, location paging by
 * `location_offset` and `location_number` (with `location_start_conflict`) over a record
 * numbered from 0 with a gap, redaction on and off (site names and addresses included, on
 * shared location numbers too), the ASR registration-number rule, leases and market blocks,
 * the required enrichment on the zero-result (miss) and under-cap (hit) pages, and
 * `format()` parity with registry text carrying CR/LF and `|`.
 * @module tests/tools/get-license.tool.test
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getLicense } from '@/mcp-server/tools/definitions/get-license.tool.js';
import { ANTENNA_TYPES } from '@/services/uls/codes.js';
import { POINTER_FILE, writePointer } from '@/services/uls/schema.js';
import {
  type ContractResult,
  contractText,
  errorOf,
  expectCarries,
  expectDeclaredError,
  formattedText,
  releaseIndex,
  successOf,
  useIndex,
} from '../fixtures/tool-harness.js';
import {
  INDIVIDUAL_SITES_WEEKLY,
  QUIRKS_WEEKLY,
  sprawlingPagingWeekly,
  widePagingWeekly,
} from '../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

type Output = Parameters<NonNullable<typeof getLicense.format>>[0];
type License = NonNullable<Output['license']>;
type Location = NonNullable<Output['locations']>[number];

/** The enrichment `get_license` declares. */
interface Enrichment {
  cap: number;
  dataAsOf: string;
  notice?: string;
  shown: number;
  truncated: boolean;
}
type Result = Output & Enrichment;

const DATA_AS_OF = '2026-09-27T13:44:10Z';

const CAP_NOTICE = (shown: number, total: number) =>
  `Showing ${shown} of ${total} frequency rows; rows beyond max_frequencies are dropped from the last locations first.`;

const run = (input: Record<string, unknown>) => runToolContract(getLicense, input as never);
const hit = (result: ContractResult) => successOf<Result>(result);
const lines = (result: ContractResult) => contractText(result).split('\n');

/** Frequency rows listed per location, in location order. */
const rowsPerLocation = (locations: readonly Location[] | undefined) =>
  (locations ?? []).map(
    (location) => location.antennas.flatMap((antenna) => antenna.frequencies).length,
  );

describe('index not available', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('get-license-cold');
  });
  afterAll(async () => {
    await releaseIndex();
    await cold.remove();
  });

  it.each([
    ['a callsign lookup', { callsign: 'KZZ901' }],
    ['a USI lookup', { usi: '1001' }],
    ['a call with neither identifier', {}],
    ['a call with both identifiers', { callsign: 'KZZ901', usi: '1001' }],
  ])(
    'fails %s on a cold index with index_not_ready before any other check',
    async (_label, input) => {
      await useIndex(cold.mirrorDir);
      const result = await run(input);
      const error = expectDeclaredError(getLicense, result, 'index_not_ready');
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe('No completed index generation is published yet.');
      expect(error.data?.retryable).toBe(false);
      expect(contractText(result)).toContain('not retryable');
      expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
    },
  );

  it('fails with index_not_ready when current.json names a missing generation', async () => {
    const dangling = await makeTempMirror('get-license-dangling');
    try {
      await writePointer(dangling.mirrorDir, {
        file: 'fcc-uls-20990101T000000Z.db',
        publishedAt: '2026-09-29T20:00:00Z',
      });
      await useIndex(dangling.mirrorDir);
      expectDeclaredError(getLicense, await run({ callsign: 'KZZ901' }), 'index_not_ready');
    } finally {
      await releaseIndex();
      await dangling.remove();
    }
  });

  it('fails with index_not_ready when current.json is malformed', async () => {
    const malformed = await makeTempMirror('get-license-malformed');
    try {
      await writeFile(join(malformed.mirrorDir, POINTER_FILE), '{"file": 42');
      await useIndex(malformed.mirrorDir);
      expectDeclaredError(getLicense, await run({ callsign: 'KZZ901' }), 'index_not_ready');
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
      ['neither identifier', {}, 'Neither callsign nor usi was given.'],
      ['only max_frequencies', { max_frequencies: 5 }, 'Neither callsign nor usi was given.'],
      [
        'a blank callsign and a blank usi',
        { callsign: '', usi: '   ' },
        'Neither callsign nor usi was given.',
      ],
      [
        'both identifiers',
        { callsign: 'KZZ901', usi: '1001' },
        'Both callsign and usi were given; pass only one.',
      ],
      [
        'both identifiers naming different records',
        { callsign: 'KZZ903', usi: '1001' },
        'Both callsign and usi were given; pass only one.',
      ],
    ])('fails identifier_required with %s', async (_label, input, message) => {
      const result = await run(input);
      const error = expectDeclaredError(getLicense, result, 'identifier_required');
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(message);
      expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
    });

    it.each([
      ['max_frequencies 0', { usi: '1001', max_frequencies: 0 }],
      ['max_frequencies 1001', { usi: '1001', max_frequencies: 1001 }],
      ['a fractional max_frequencies', { usi: '1001', max_frequencies: 2.5 }],
      ['usi 0', { usi: '0' }],
      ['a usi with a leading zero', { usi: '01001' }],
      ['a usi with a letter', { usi: '10a1' }],
      ['an 11-digit usi', { usi: '12345678901' }],
      ['a prefix-portable callsign', { callsign: 'VE3/N0CALL' }],
      ['a prefix-portable callsign with a 4-character base', { callsign: 'KH6/W1AW' }],
      ['a wildcard callsign', { callsign: 'KZZ*' }],
      ['a two-character callsign', { callsign: 'KZ' }],
    ])('rejects %s with InvalidParams', async (_label, input) => {
      const error = errorOf(await run(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
    });
  });

  describe('inputs', () => {
    it('normalizes case, spaces, and a portable suffix on the callsign', async () => {
      const result = hit(await run({ callsign: ' kzz 901/4 ' }));
      expect(result.found).toBe(true);
      expect(result.license?.usi).toBe('1001');
    });

    it('reads a blank callsign as unset when usi is given, and the reverse', async () => {
      const parsed = getLicense.input.parse({ callsign: '  ', usi: '1005' });
      expect(parsed).toEqual({
        usi: '1005',
        max_frequencies: 100,
        location_offset: 0,
        lease_offset: 0,
      });
      expect(hit(await run({ callsign: '  ', usi: '1005' })).license?.usi).toBe('1005');
      expect(hit(await run({ callsign: 'KZZ903', usi: '' })).license?.usi).toBe('1003');
    });

    it('accepts an integer usi as its digits and trims a padded one', async () => {
      expect(hit(await run({ usi: 1005 })).license?.usi).toBe('1005');
      expect(hit(await run({ usi: ' 1005 ' })).license?.usi).toBe('1005');
    });
  });

  describe('lookups', () => {
    it('resolves a shared callsign to the active record and lists the other one', async () => {
      const result = await run({ callsign: 'KZZ901' });
      const structured = hit(result);
      expect(structured).toMatchObject({
        found: true,
        technicalRetained: true,
        license: { usi: '1001', callsign: 'KZZ901', licenseStatus: 'A' },
        otherCallsignRecords: [{ usi: '1005', licenseStatus: 'E' }],
      });
      expect(structured).not.toHaveProperty('guidance');
      expect(structured).not.toHaveProperty('candidates');
      expect(lines(result)).toContain('**Other records under this callsign:** USI 1005 (E)');
    });

    it('returns a non-live record by USI with technicalRetained false and says why', async () => {
      const result = await run({ usi: '1005' });
      const structured = hit(result);
      expect(structured).toMatchObject({
        found: true,
        technicalRetained: false,
        locations: [],
        otherCallsignRecords: [{ usi: '1001', licenseStatus: 'A' }],
        license: {
          usi: '1005',
          licenseStatus: 'E',
          statusLabel: 'Expired',
          expiredDate: '2011-02-01',
        },
        shown: 0,
        truncated: false,
      });
      const rendered = lines(result);
      expect(rendered).toContain('**Technical records retained:** no');
      expect(rendered).toContain(
        'Sites and frequencies are kept only for active (A), pending-legal (L), and term-pending (X) records, so this record lists none.',
      );
      expect(rendered).toContain('### Locations (0)');
    });

    it('returns five callsign-prefix candidates and the callsign guidance on a miss', async () => {
      const result = await run({ callsign: 'kzz9' });
      const structured = hit(result);
      const guidance =
        'No record with callsign KZZ9 in the indexed service groups. Try fcc_spectrum_search_licenses with licensee or frn, or call fcc_spectrum_list_reference with topic "coverage".';
      expect(structured).toMatchObject({ found: false, guidance });
      expect(structured.candidates).toEqual([
        { callsign: 'KZZ901', usi: '1001', licenseStatus: 'A' },
        { callsign: 'KZZ901', usi: '1005', licenseStatus: 'E' },
        { callsign: 'KZZ902', usi: '1002', licenseStatus: 'C' },
        { callsign: 'KZZ903', usi: '1003', licenseStatus: 'A' },
        { callsign: 'KZZ906', usi: '1006', licenseStatus: 'X' },
      ]);
      for (const key of ['license', 'locations', 'technicalRetained', 'otherCallsignRecords']) {
        expect(structured).not.toHaveProperty(key);
      }
      const rendered = lines(result);
      expect(rendered.slice(0, 5)).toEqual([
        '**Found:** no',
        '',
        '## No matching FCC ULS record',
        '',
        guidance,
      ]);
      expect(rendered).toContain('**Callsigns starting with the one requested:**');
      expect(rendered).toContain('- KZZ906 · USI 1006 · status X');
    });

    it('returns the USI guidance and leaves callsign-prefix candidates out on a USI miss', async () => {
      const result = await run({ usi: '424242' });
      const structured = hit(result);
      expect(structured).toMatchObject({
        found: false,
        guidance:
          'No record with USI 424242; USIs come from the usi field of fcc_spectrum_search_licenses, fcc_spectrum_find_transmitters, and fcc_spectrum_search_frequencies results.',
      });
      expect(structured).not.toHaveProperty('candidates');
      expect(contractText(result)).not.toContain('callsign-prefix');
    });

    it('returns no candidates for a callsign nothing starts with', async () => {
      const result = await run({ callsign: 'QQQ123' });
      expect(hit(result)).toMatchObject({ found: false, candidates: [] });
      expect(contractText(result)).toContain('No record with callsign QQQ123');
      expect(lines(result)).toContain('No callsign-prefix candidates.');
    });
  });

  describe('max_frequencies', () => {
    it('drops rows past the cap from the last location first and discloses it', async () => {
      const result = await run({ usi: '1001', max_frequencies: 2 });
      const structured = hit(result);
      const notice = `${CAP_NOTICE(2, 4)} Raise max_frequencies (up to 1000) to see more.`;
      expect(structured).toMatchObject({
        dataAsOf: DATA_AS_OF,
        truncated: true,
        shown: 2,
        cap: 2,
        notice,
      });
      expect(rowsPerLocation(structured.locations)).toEqual([2, 0]);
      const rendered = contractText(result);
      expect(rendered).toContain(`> ${notice}`);
      expect(rendered).toContain('**truncated:** true');
    });

    it('is not truncated when the cap equals the row count', async () => {
      const structured = hit(await run({ usi: '1001', max_frequencies: 4 }));
      expect(structured).toMatchObject({ truncated: false, shown: 4, cap: 4 });
      expect(structured.notice).toBeUndefined();
      expect(rowsPerLocation(structured.locations)).toEqual([3, 1]);
    });
  });

  describe('redaction', () => {
    it("withholds an individual's name, mailing city, and site address while redacting", async () => {
      const result = await run({ callsign: 'KZZ903' });
      const structured = hit(result);
      expect(structured.license?.licensee).toEqual({
        name: null,
        redacted: true,
        role: 'licensee',
        frn: '0005550001',
        applicantType: 'I',
        state: 'WA',
      });
      const [site] = structured.locations ?? [];
      expect(site).not.toHaveProperty('address');
      expect(site).not.toHaveProperty('name');
      expect(site).toMatchObject({ city: 'SPOKANE', state: 'WA' });
      expect(JSON.stringify(result.structuredContent)).not.toContain('Pat Q Example');
      const rendered = contractText(result);
      expect(rendered.split('\n')).toContain(
        '**Licensee:** Redacted (individual licensee) · **Redacted:** yes · **Role:** licensee · **FRN:** 0005550001 · **Applicant type:** I · **State:** WA',
      );
      expect(rendered.split('\n')).toContain('#### Location 1');
      expect(rendered.split('\n')).toContain('**Place:** SPOKANE, WA (state as filed)');
      expect(rendered).not.toContain('Pat Q Example');
      expect(rendered).not.toContain('42 Private Lane');
    });

    it("keeps an organization's site name in both surfaces while redacting", async () => {
      const result = await run({ callsign: 'KZZ901' });
      expect(hit(result).locations?.[0]?.name).toBe('Seattle Hill');
      expect(lines(result)).toContain('#### Location 1 — Seattle Hill');
    });

    it("shows the individual's name, city, site address, and site name with redaction off", async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = await run({ callsign: 'KZZ903' });
      const structured = hit(result);
      expect(structured.license?.licensee).toMatchObject({
        name: 'Pat Q Example',
        redacted: false,
        city: 'SPOKANE',
      });
      expect(structured.locations?.[0]).toMatchObject({
        address: '42 Private Lane',
        name: 'Pat Q Example',
      });
      const rendered = lines(result);
      expect(rendered).toContain(
        '**Licensee:** Pat Q Example · **Redacted:** no · **Role:** licensee · **FRN:** 0005550001 · **Applicant type:** I · **City:** SPOKANE · **State:** WA',
      );
      expect(rendered).toContain('#### Location 1 — Pat Q Example');
      expect(rendered).toContain('**Place:** 42 Private Lane, SPOKANE, WA (state as filed)');
    });

    it('renders a withheld trustee name as "redacted" and shows it with redaction off', async () => {
      const redacted = await run({ callsign: 'KZ1CLB' });
      expect(hit(redacted).license?.amateur).toEqual({
        trusteeCallsign: 'KZ1AAA',
        trusteeName: null,
      });
      expect(lines(redacted)).toContain(
        '**Trustee callsign:** KZ1AAA · **Trustee name:** redacted',
      );

      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const open = await run({ callsign: 'KZ1CLB' });
      expect(hit(open).license?.amateur?.trusteeName).toBe('Trustee Person Example');
      expect(lines(open)).toContain(
        '**Trustee callsign:** KZ1AAA · **Trustee name:** Trustee Person Example',
      );
    });

    it('redacts an amateur with a blank applicant type and renders the operator class', async () => {
      const result = await run({ callsign: 'KZ1AAA' });
      expect(hit(result).license).toMatchObject({
        licensee: { name: null, redacted: true },
        amateur: {
          operatorClass: 'E',
          operatorClassLabel: 'Amateur Extra',
          previousCallsign: 'KZ1ZZZ',
        },
      });
      const rendered = contractText(result);
      expect(rendered.split('\n')).toContain(
        '**Operator class:** E (Amateur Extra) · **Previous callsign:** KZ1ZZZ',
      );
      expect(rendered).not.toContain('Alex Amateur Example');
      expect(rendered).not.toContain('DENVER');
    });
  });

  describe('leases and markets', () => {
    it('labels a lease record with its lessee and the license it is leased from', async () => {
      const result = await run({ callsign: 'l000000001' });
      const structured = hit(result);
      expect(structured.license).toMatchObject({
        usi: '2002',
        isLease: true,
        licensee: { name: 'Leaseholder Wireless LLC', role: 'lessee' },
        leasedFrom: [{ callsign: 'KZZ801', usi: '2001' }],
        leases: [],
        leaseCount: 0,
        market: { marketCode: 'BTA138', blocks: [{ lowMhz: 2496, highMhz: 2502 }] },
      });
      const rendered = lines(result);
      expect(rendered).toContain('## L000000001 · USI 2002');
      expect(rendered).toContain(
        '**Lessee:** Leaseholder Wireless LLC · **Redacted:** no · **Role:** lessee · **FRN:** 0004445555 · **Applicant type:** L · **City:** MINNEAPOLIS · **State:** MN',
      );
      expect(rendered).toContain('**Leased from:** KZZ801 (USI 2001)');
      expect(rendered).toContain('**Leases:** 0');
      expect(rendered.find((line) => line.startsWith('**Status:**'))).toMatch(
        /\*\*Lease:\*\* yes$/,
      );
    });

    it('lists the market blocks and leases of a parent license', async () => {
      const result = await run({ callsign: 'KZZ801' });
      const structured = hit(result);
      expect(structured.license?.market).toEqual({
        marketCode: 'BTA138',
        marketName: 'Fargo-Moorhead, ND-MN',
        channelBlock: 'A1',
        blocks: [
          { lowMhz: 2496, highMhz: 2502, partitionAreaIds: [1] },
          { lowMhz: 2502, highMhz: 2508 },
        ],
      });
      expect(structured.license?.leases).toEqual([
        { callsign: 'L000000001', usi: '2002', licenseStatus: 'A' },
        { callsign: 'L000000002', usi: '2004', licenseStatus: 'A' },
      ]);
      const rendered = lines(result);
      expect(rendered).toContain(
        '**Market:** BTA138 — Fargo-Moorhead, ND-MN · **Channel block:** A1',
      );
      expect(rendered).toContain(
        '**Spectrum blocks:** 2496–2502 MHz (partition area 1), 2502–2508 MHz',
      );
      expect(rendered).toContain('**Leases:** 2');
      expect(rendered).toContain('- L000000001 · USI 2002 · status A');
      expect(rendered).toContain('- L000000002 · USI 2004 · status A');
    });

    it('keeps a lease link to a parent the index does not hold', async () => {
      const result = await run({ usi: '2006' });
      expect(hit(result).license?.leasedFrom).toEqual([{ callsign: 'KZZ999', usi: '9999' }]);
      expect(lines(result)).toContain('**Leased from:** KZZ999 (USI 9999)');
    });
  });

  describe('registry text', () => {
    it('keeps a CR verbatim in structuredContent and flattens it in content[]', async () => {
      const result = await run({ callsign: 'KZZ907' });
      expect(hit(result).license?.licensee.name).toBe('Carriage\rReturn Paging');
      const rendered = contractText(result);
      expect(rendered).not.toContain('\r');
      expect(rendered.split('\n')).toContain(
        '**Licensee:** Carriage Return Paging · **Redacted:** no · **Role:** licensee · **FRN:** 0002223333 · **Applicant type:** C · **City:** BOISE · **State:** ID',
      );
    });

    it('renders coordinates that fail validation as not valid, with the filed DMS', async () => {
      const result = await run({ callsign: 'KZZ907' });
      const [site] = hit(result).locations ?? [];
      expect(site).not.toHaveProperty('latitude');
      expect(site).not.toHaveProperty('longitude');
      expect(site?.coordinatesDms).toBe('43-61-0 N 116-12-0 W');
      expect(lines(result)).toContain(
        '**Type:** F (Fixed) · **Coordinates:** not valid as filed · **Filed DMS:** 43-61-0 N 116-12-0 W',
      );
    });
  });

  describe('enrichment contract (runToolContract)', () => {
    it('carries every required field on the zero-result page (a miss), with no notice', async () => {
      const result = await run({ callsign: 'KZZ9' });
      const structured = hit(result);
      expect(structured).toMatchObject({
        found: false,
        dataAsOf: DATA_AS_OF,
        truncated: false,
        shown: 0,
        cap: 100,
      });
      expect(structured.notice).toBeUndefined();
      const rendered = contractText(result);
      for (const field of [
        `**dataAsOf:** ${DATA_AS_OF}`,
        '**truncated:** false',
        '**shown:** 0',
        '**cap:** 100',
      ]) {
        expect(rendered).toContain(field);
      }
      expectCarries(rendered, { guidance: structured.guidance, candidates: structured.candidates });
    });

    it('carries every record field on an under-cap page (a hit), with no notice', async () => {
      const result = await run({ callsign: 'KZZ901' });
      const structured = hit(result);
      expect(structured).toMatchObject({
        found: true,
        dataAsOf: DATA_AS_OF,
        truncated: false,
        shown: 4,
        cap: 100,
      });
      expect(structured.notice).toBeUndefined();
      const rendered = contractText(result);
      expectCarries(rendered, {
        license: structured.license,
        locations: structured.locations,
        otherCallsignRecords: structured.otherCallsignRecords,
      });
      expect(rendered).toContain('**Found:** yes');
      expect(rendered).toContain('**Lease:** no');
      expect(rendered).toContain('**Technical records retained:** yes');
      expect(rendered).toContain('**Place:** TACOMA, WA (state derived from coordinates)');
      expect(rendered).toContain('**shown:** 4');
    });

    it.each([
      ['a lease with a market', { callsign: 'L000000001' }],
      ['a parent license with leases and sites', { callsign: 'KZZ801' }],
      ['an amateur record', { callsign: 'KZ1AAA' }],
      ['a record with invalid coordinates', { callsign: 'KZZ907' }],
    ])('renders every value of %s in content[]', async (_label, input) => {
      const result = await run(input);
      const structured = hit(result);
      expectCarries(contractText(result), {
        license: structured.license,
        locations: structured.locations,
        otherCallsignRecords: structured.otherCallsignRecords,
      });
    });
  });
});

describe('the 1000-row ceiling', () => {
  let wide: FixtureIndex;
  beforeAll(async () => {
    wide = await buildFixtureIndex({ weekly: { paging: widePagingWeekly(1001) } });
  });
  beforeEach(async () => {
    await useIndex(wide.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await wide.dispose();
  });

  it('says no call returns more than 1000 rows when the cap is at the ceiling', async () => {
    const structured = hit(await run({ callsign: 'KZZ401', max_frequencies: 1000 }));
    expect(structured).toMatchObject({
      truncated: true,
      shown: 1000,
      cap: 1000,
      notice: `${CAP_NOTICE(1000, 1001)} No call returns more than 1000 rows.`,
    });
    expect(rowsPerLocation(structured.locations)).toEqual([1000]);
  });

  it('points below the ceiling at raising max_frequencies', async () => {
    const structured = hit(await run({ usi: '4001', max_frequencies: 999 }));
    expect(structured).toMatchObject({
      truncated: true,
      shown: 999,
      cap: 999,
      notice: `${CAP_NOTICE(999, 1001)} Raise max_frequencies (up to 1000) to see more.`,
    });
  });

  it('applies the default cap of 100', async () => {
    const structured = hit(await run({ usi: '4001' }));
    expect(structured).toMatchObject({ truncated: true, shown: 100, cap: 100 });
    expect(structured.notice?.startsWith(CAP_NOTICE(100, 1001))).toBe(true);
  });
});

/** Sites a page lists: a number filed at several sites counts each of them. */
const sitesListed = (locations: readonly Location[] | undefined) =>
  (locations ?? []).reduce((sum, location) => sum + (location.sites?.length ?? 1), 0);

describe('paging a large license', () => {
  let sprawl: FixtureIndex;
  beforeAll(async () => {
    sprawl = await buildFixtureIndex({
      weekly: {
        paging: sprawlingPagingWeekly({
          locations: 60,
          sitesAtFirst: 3,
          antennasPerLocation: 1,
          leases: 130,
        }),
      },
    });
  });
  beforeEach(async () => {
    await useIndex(sprawl.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await sprawl.dispose();
  });

  const NEXT_LOCATIONS =
    'Listing 48 of 60 locations (50 of 62 sites) from location_offset 0; one call lists at most 50 sites and 100 antennas. Call fcc_spectrum_get_license with usi "7001" and location_offset 48 for the next locations.';
  const NEXT_LEASES =
    'Listing leases 1–100 of 130; call fcc_spectrum_get_license with usi "7001" and lease_offset 100 for the next ones.';

  it('stops the first page at 50 sites and 100 leases and names both next offsets', async () => {
    const result = await run({ callsign: 'KZZ701' });
    const structured = hit(result);
    expect(structured).toMatchObject({
      truncated: true,
      shown: 48,
      cap: 100,
      locationTotal: 60,
      siteTotal: 62,
      nextLocationOffset: 48,
      nextLeaseOffset: 100,
      notice: `${NEXT_LOCATIONS} ${NEXT_LEASES}`,
    });
    expect(structured.locations).toHaveLength(48);
    expect(sitesListed(structured.locations)).toBe(50);
    expect(structured.locations?.[0]?.sites).toHaveLength(3);
    expect(structured.license?.leases).toHaveLength(100);
    expect(structured.license?.leaseCount).toBe(130);
    const rendered = contractText(result);
    expect(rendered).toContain('### Locations (48 of 60 listed; 62 sites in all)');
    expect(rendered).toContain('**Next location_offset:** 48');
    expect(rendered).toContain('**Leases:** 130 (100 listed)');
    expect(rendered).toContain('**Next lease_offset:** 100');
    expectCarries(rendered, {
      license: structured.license,
      locations: structured.locations,
      otherCallsignRecords: structured.otherCallsignRecords,
    });
  });

  it('reads the next locations from location_offset, ending without a next offset', async () => {
    const structured = hit(await run({ usi: '7001', location_offset: 48 }));
    expect(structured.locations?.map((location) => location.locationNumber)).toEqual(
      Array.from({ length: 12 }, (_, i) => 49 + i),
    );
    expect(structured).toMatchObject({ locationTotal: 60, siteTotal: 62, shown: 12 });
    expect(structured).not.toHaveProperty('nextLocationOffset');
    expect(structured.notice).toBe(NEXT_LEASES);
  });

  it('pages leases with lease_offset', async () => {
    const structured = hit(await run({ usi: '7001', lease_offset: 100 }));
    expect(structured.license?.leases.map((lease) => lease.callsign)).toEqual(
      Array.from({ length: 30 }, (_, i) => `L0000${70_101 + i}`),
    );
    expect(structured).not.toHaveProperty('nextLeaseOffset');
    expect(structured.notice).toBe(NEXT_LOCATIONS);
  });

  it('names the location where max_frequencies starts dropping rows', async () => {
    const structured = hit(await run({ usi: '7001', max_frequencies: 10 }));
    expect(rowsPerLocation(structured.locations)).toEqual([
      ...Array.from({ length: 10 }, () => 1),
      ...Array.from({ length: 38 }, () => 0),
    ]);
    expect(structured).toMatchObject({ truncated: true, shown: 10, cap: 10 });
    expect(structured.notice).toBe(
      `${NEXT_LOCATIONS} ${CAP_NOTICE(10, 48)} Rows are missing from location 11 on; call again with location_offset 10 to start there, or raise max_frequencies (up to 1000). ${NEXT_LEASES}`,
    );
  });

  it('says an offset past the end lists nothing', async () => {
    const structured = hit(await run({ usi: '7001', location_offset: 60, lease_offset: 130 }));
    expect(structured).toMatchObject({ truncated: false, shown: 0, locations: [] });
    expect(structured.license?.leases).toEqual([]);
    expect(structured.notice).toBe(
      'location_offset 60 is past the last location; this record has 60. lease_offset 130 is past the last lease; this record has 130.',
    );
  });
});

describe('one location over the page caps', () => {
  let dense: FixtureIndex;
  beforeAll(async () => {
    dense = await buildFixtureIndex({
      weekly: {
        paging: sprawlingPagingWeekly({
          locations: 41,
          sitesAtFirst: 70,
          antennasPerLocation: 3,
          leases: 0,
        }),
      },
    });
  });
  beforeEach(async () => {
    await useIndex(dense.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await dense.dispose();
  });

  it('lists a location whole even when its sites alone exceed the cap', async () => {
    const structured = hit(await run({ usi: '7001' }));
    expect(structured.locations).toHaveLength(1);
    expect(structured.locations?.[0]?.sites).toHaveLength(70);
    expect(structured.locations?.[0]?.antennas).toHaveLength(3);
    expect(structured).toMatchObject({ locationTotal: 41, siteTotal: 110, nextLocationOffset: 1 });
  });

  it('stops a page before its antennas pass 100', async () => {
    const structured = hit(await run({ usi: '7001', location_offset: 1 }));
    expect(structured.locations).toHaveLength(33);
    expect(structured.locations?.flatMap((location) => location.antennas)).toHaveLength(99);
    expect(structured.nextLocationOffset).toBe(34);
  });
});

/**
 * KZZ701 numbered from 0 with a gap: sites at 0–59 and 70–129, and 135 filed on antenna and
 * frequency rows alone, two antennas and two rows at each. Its windows are 0–49 (offset 0),
 * 50–59 and 70–109 (offset 50), and 110–129 with 135 (offset 100).
 */
const GAPPED_NUMBERS = [
  ...Array.from({ length: 60 }, (_, i) => i),
  ...Array.from({ length: 60 }, (_, i) => i + 70),
];
const numbersListed = (locations: readonly Location[] | undefined) =>
  (locations ?? []).map((location) => location.locationNumber);
const range = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);
const GAPPED_WINDOW = (from: number, next: number) =>
  `Listing 50 of 121 locations (50 of 120 sites) from location_offset ${from}; one call lists at most 50 sites and 100 antennas. Call fcc_spectrum_get_license with usi "7001" and location_offset ${next} for the next locations.`;

describe('a record numbered from 0 with a gap', () => {
  let gapped: FixtureIndex;
  beforeAll(async () => {
    gapped = await buildFixtureIndex({
      weekly: {
        paging: sprawlingPagingWeekly({
          locations: GAPPED_NUMBERS,
          siteless: [135],
          sitesAtFirst: 1,
          antennasPerLocation: 2,
          leases: 0,
        }),
      },
    });
  });
  beforeEach(async () => {
    await useIndex(gapped.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await gapped.dispose();
  });

  describe('location_offset', () => {
    it('counts location 0 first and pages across the gap in number order', async () => {
      const first = hit(await run({ callsign: 'KZZ701' }));
      expect(numbersListed(first.locations)).toEqual(range(0, 49));
      expect(first).toMatchObject({
        locationTotal: 121,
        siteTotal: 120,
        nextLocationOffset: 50,
        notice: GAPPED_WINDOW(0, 50),
      });

      const second = hit(await run({ usi: '7001', location_offset: 50 }));
      expect(numbersListed(second.locations)).toEqual([...range(50, 59), ...range(70, 109)]);
      expect(second).toMatchObject({ nextLocationOffset: 100, notice: GAPPED_WINDOW(50, 100) });
    });

    it('lists a number filed only on antenna and frequency rows in its place, without a site', async () => {
      const result = await run({ usi: '7001', location_offset: 100 });
      const last = hit(result);
      expect(numbersListed(last.locations)).toEqual([...range(110, 129), 135]);
      const siteless = last.locations?.at(-1);
      expect(siteless?.antennas).toHaveLength(2);
      expect(siteless).not.toHaveProperty('latitude');
      expect(last).not.toHaveProperty('nextLocationOffset');
      expect(last.notice).toBeUndefined();
      expect(lines(result)).toContain('#### Location 135');
    });

    it('says an offset past the end lists nothing', async () => {
      const structured = hit(await run({ usi: '7001', location_offset: 121 }));
      expect(structured).toMatchObject({ truncated: false, shown: 0, locations: [] });
      expect(structured.notice).toBe(
        'location_offset 121 is past the last location; this record has 121.',
      );
    });
  });

  describe('location_number', () => {
    it('starts at location 0 with the window location_offset 0 lists', async () => {
      const result = await run({ callsign: 'KZZ701', location_number: 0 });
      expect(hit(result)).toEqual(hit(await run({ callsign: 'KZZ701' })));
      expect(numbersListed(hit(result).locations)[0]).toBe(0);
    });

    it('starts at a filed number and names its offset in the notice and the next offset', async () => {
      const result = await run({ callsign: 'KZZ701', location_number: 55 });
      const structured = hit(result);
      expect(numbersListed(structured.locations)).toEqual([...range(55, 59), ...range(70, 114)]);
      expect(structured).toMatchObject({
        truncated: true,
        nextLocationOffset: 105,
        notice: GAPPED_WINDOW(55, 105),
      });
      expect(lines(result)).toEqual(
        expect.arrayContaining([
          '### Locations (50 of 121 listed; 120 sites in all)',
          '#### Location 55 — SITE 55-1',
          '**Next location_offset:** 105',
        ]),
      );
      expect(contractText(result)).toContain(GAPPED_WINDOW(55, 105));
    });

    it('reads a page past the first two windows, ending without a next offset or notice', async () => {
      const structured = hit(await run({ usi: '7001', location_number: 110 }));
      expect(numbersListed(structured.locations)).toEqual([...range(110, 129), 135]);
      expect(structured).toMatchObject({ truncated: false, shown: 42 });
      expect(structured).not.toHaveProperty('nextLocationOffset');
      expect(structured.notice).toBeUndefined();
    });

    it('starts an unfiled number at the next filed one and says where the window starts', async () => {
      const START =
        'Location 65 is not filed on this record; listing from location 70 (location_offset 60).';
      const result = await run({ usi: '7001', location_number: 65 });
      const structured = hit(result);
      expect(numbersListed(structured.locations)).toEqual(range(70, 119));
      expect(structured).toMatchObject({
        truncated: true,
        nextLocationOffset: 110,
        notice: `${START} ${GAPPED_WINDOW(60, 110)}`,
      });
      expect(contractText(result)).toContain(START);
    });

    it('starts at a number filed only on antenna and frequency rows', async () => {
      const result = await run({ usi: '7001', location_number: 131 });
      const structured = hit(result);
      expect(numbersListed(structured.locations)).toEqual([135]);
      expect(structured.notice).toBe(
        'Location 131 is not filed on this record; listing from location 135 (location_offset 120).',
      );
      expect(structured.truncated).toBe(false);
    });

    it('lists nothing past the last filed number and names it with the location count', async () => {
      const PAST =
        'Location 136 is past the last filed location, 135; this record has 121 locations.';
      const result = await run({ usi: '7001', location_number: 136 });
      const structured = hit(result);
      expect(structured).toMatchObject({
        truncated: false,
        shown: 0,
        locations: [],
        locationTotal: 121,
        notice: PAST,
      });
      expect(structured).not.toHaveProperty('nextLocationOffset');
      expect(contractText(result)).toContain(PAST);
    });

    it('reads the frequency cut against the offset the number resolved to', async () => {
      // The first listed location loses rows: raising the cap is the only remedy.
      const atFirst = hit(await run({ usi: '7001', location_number: 65, max_frequencies: 1 }));
      expect(atFirst.notice).toBe(
        `Location 65 is not filed on this record; listing from location 70 (location_offset 60). ${GAPPED_WINDOW(60, 110)} ${CAP_NOTICE(1, 100)} Raise max_frequencies (up to 1000) to see more.`,
      );
      const later = hit(await run({ usi: '7001', location_number: 70, max_frequencies: 3 }));
      expect(later.notice).toBe(
        `${GAPPED_WINDOW(60, 110)} ${CAP_NOTICE(3, 100)} Rows are missing from location 71 on; call again with location_offset 61 to start there, or raise max_frequencies (up to 1000).`,
      );
    });

    it('fails location_start_conflict beside a nonzero location_offset', async () => {
      const result = await run({ usi: '7001', location_number: 110, location_offset: 5 });
      const error = expectDeclaredError(getLicense, result, 'location_start_conflict');
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(
        'Both location_number and a nonzero location_offset were given; pass only one.',
      );
      expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
    });

    it('defers to location_number when location_offset is 0', async () => {
      const structured = hit(await run({ usi: '7001', location_number: 110, location_offset: 0 }));
      expect(numbersListed(structured.locations)[0]).toBe(110);
    });

    it('says a record with no locations does not file the number', async () => {
      const structured = hit(await run({ callsign: 'KZ1CLB', location_number: 1 }));
      expect(structured).toMatchObject({
        technicalRetained: true,
        locations: [],
        locationTotal: 0,
        truncated: false,
        notice: 'Location 1 is not filed; this record has 0 locations.',
      });
    });

    it.each([
      ['a negative number', { usi: '7001', location_number: -1 }],
      ['a fractional number', { usi: '7001', location_number: 1.5 }],
      ['a string', { usi: '7001', location_number: 'one' }],
    ])('rejects %s with InvalidParams', async (_label, input) => {
      const error = errorOf(await run(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    });
  });
});

/**
 * KZZ701 numbering 1–69, each number with one antenna and one frequency row, where 10, 30,
 * and 55 are filed on that frequency row alone (no site, no antenna record). Its windows are
 * 1–52 (offset 0, 50 sites) and 53–69 (offset 52).
 */
const FREQUENCY_ONLY = [10, 30, 55];

describe('location numbers filed only on frequency rows', () => {
  let sparse: FixtureIndex;
  beforeAll(async () => {
    sparse = await buildFixtureIndex({
      weekly: {
        paging: sprawlingPagingWeekly({
          locations: range(1, 69).filter((number) => !FREQUENCY_ONLY.includes(number)),
          frequencyOnly: FREQUENCY_ONLY,
          sitesAtFirst: 1,
          antennasPerLocation: 1,
          leases: 0,
        }),
      },
    });
  });
  beforeEach(async () => {
    await useIndex(sparse.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await sparse.dispose();
  });

  /** Every location number a walk from offset 0 lists, following nextLocationOffset. */
  const walk = async (maxFrequencies: number) => {
    const listed: number[] = [];
    let next: number | undefined = 0;
    while (next !== undefined) {
      const offset: number = next;
      const structured = hit(
        await run({ usi: '7001', location_offset: offset, max_frequencies: maxFrequencies }),
      );
      next = structured.nextLocationOffset;
      expect(structured.locationTotal).toBe(69);
      expect(structured.locations).toHaveLength((next ?? 69) - offset);
      listed.push(...numbersListed(structured.locations));
    }
    return listed;
  };

  it('lists a frequency-only number whose rows max_frequencies cuts, with no antennas', async () => {
    const result = await run({ usi: '7001', max_frequencies: 1 });
    const structured = hit(result);
    expect(structured).toMatchObject({
      locationTotal: 69,
      siteTotal: 66,
      nextLocationOffset: 52,
      shown: 1,
      truncated: true,
    });
    expect(numbersListed(structured.locations)).toEqual(range(1, 52));
    expect(structured.locations).toHaveLength(structured.nextLocationOffset ?? 0);
    const cut = structured.locations?.find((location) => location.locationNumber === 10);
    expect(cut).toEqual({ locationNumber: 10, antennas: [] });
    expect(structured.notice).toContain(
      'Rows are missing from location 2 on; call again with location_offset 1 to start there',
    );
    expect(lines(result)).toEqual(expect.arrayContaining(['#### Location 10', '#### Location 30']));
  });

  it('lists a frequency-only number with its row under its antenna when the row fits', async () => {
    const structured = hit(await run({ usi: '7001', location_number: 10, max_frequencies: 1 }));
    expect(structured.locations?.[0]).toEqual({
      locationNumber: 10,
      antennas: [
        {
          antennaNumber: 1,
          frequencies: [expect.objectContaining({ frequencyMhz: 150.125, stationClass: 'FB2' })],
        },
      ],
    });
  });

  it.each([[1], [20], [100]])(
    'walks every location number exactly once at max_frequencies %i',
    async (maxFrequencies) => {
      expect(await walk(maxFrequencies)).toEqual(range(1, 69));
    },
  );
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

  it('shows a PAL block filed as 0–10 MHz as a channel width the SAS assigns', async () => {
    const result = await run({ callsign: 'KZZ503' });
    const structured = hit(result);
    expect(structured.license?.market?.blocks).toMatchObject([{ channelWidthMhz: 10 }]);
    expect(structured.license?.market?.blocks[0]).not.toHaveProperty('lowMhz');
    expect(lines(result)).toEqual(
      expect.arrayContaining([
        '**Spectrum blocks:** 10 MHz channel, no frequency filed (partition area 41001)',
        'The Spectrum Access System assigns each PAL channel within 3550–3650 MHz, so ULS files its width rather than its frequencies.',
      ]),
    );
    expectCarries(contractText(result), structured.license);
  });

  it('lists a band filed under several partition areas once, with the areas', async () => {
    const result = await run({ callsign: 'KZZ504' });
    const structured = hit(result);
    const partitionAreaIds = [8183, 8184, 96978];
    expect(structured.license?.market?.blocks).toEqual([
      { lowMhz: 1755, highMhz: 1760, partitionAreaIds },
      { lowMhz: 2155, highMhz: 2160, partitionAreaIds },
    ]);
    expect(lines(result)).toContain(
      '**Spectrum blocks:** 1755–1760 MHz (partition areas 8183, 8184, 96978), 2155–2160 MHz (partition areas 8183, 8184, 96978)',
    );
    expectCarries(contractText(result), structured.license);
  });

  it('lists every site under a shared location number and ties the frequencies to the number', async () => {
    const result = await run({ callsign: 'KZZ505' });
    const structured = hit(result);
    const [shared, single] = structured.locations ?? [];
    expect(shared?.sites).toHaveLength(2);
    expect(shared?.antennas[0]?.recordCount).toBe(2);
    expect(single).not.toHaveProperty('sites');
    expect(lines(result)).toEqual(
      expect.arrayContaining([
        '#### Location 1 — 2 sites share this number',
        'The antennas and frequencies below are filed against location 1, and ULS does not say which of its 2 sites uses each.',
        '##### Site 1 of 2 — 33 SR99 North Rd',
        '##### Site 2 of 2 — 35 I5 Northgate',
        '#### Location 2 — Single Site',
      ]),
    );
    expect(contractText(result)).toContain(
      '**Filed records:** 2 (fields that differ between them are omitted)',
    );
    expectCarries(contractText(result), structured.locations);
  });

  it('returns asrNumber only for a seven-digit registration number, in both surfaces', async () => {
    const result = await run({ callsign: 'KZZ505' });
    const [shared, single] = hit(result).locations ?? [];
    expect(shared?.sites?.map((site) => site.asrNumber)).toEqual([undefined, undefined]);
    expect(single?.asrNumber).toBe('1012345');
    const rendered = contractText(result);
    expect(rendered.match(/\*\*ASR:\*\*/g)).toHaveLength(1);
    expect(rendered).toContain('**ASR:** 1012345');
    expect(rendered).not.toContain('N/A');
    expect(rendered).not.toContain('9999999');

    const fileNumber = await run({ callsign: 'KZZ502' });
    expect(hit(fileNumber).locations?.[0]).not.toHaveProperty('asrNumber');
    expect(contractText(fileNumber)).not.toContain('**ASR:**');
    expect(contractText(fileNumber)).not.toContain('A1090210');
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
    await releaseIndex();
    await individual.dispose();
  });

  it('withholds every site name and address, shared numbers included, while redacting', async () => {
    await useIndex(individual.mirrorDir, { services: ['paging'] });
    const result = await run({ callsign: 'KZZ521' });
    const [shared, single] = hit(result).locations ?? [];
    expect(shared?.sites).toHaveLength(2);
    for (const site of [...(shared?.sites ?? []), single]) {
      expect(site).not.toHaveProperty('name');
      expect(site).not.toHaveProperty('address');
    }
    const rendered = contractText(result);
    expect(rendered.split('\n')).toEqual(
      expect.arrayContaining([
        '#### Location 1 — 2 sites share this number',
        '##### Site 1 of 2',
        '##### Site 2 of 2',
        '#### Location 2',
        '**Place:** YAKIMA, WA (state as filed)',
        '**Place:** SELAH, WA (state as filed)',
      ]),
    );
    const body = JSON.stringify(result.structuredContent);
    for (const filed of ['Robin', 'Sample', 'SAMPLE', 'Orchard', 'Ridge Rd']) {
      expect(rendered, filed).not.toContain(filed);
      expect(body, filed).not.toContain(filed);
    }
  });

  it('returns them in both surfaces with redaction off', async () => {
    await useIndex(individual.mirrorDir, { services: ['paging'], redactIndividuals: false });
    const result = await run({ callsign: 'KZZ521' });
    const [shared, single] = hit(result).locations ?? [];
    expect(shared?.sites?.map((site) => site.name)).toEqual(['Robin R Sample', 'SAMPLE BARN']);
    expect(single).toMatchObject({ name: 'Sample Ridge', address: '11 Ridge Rd' });
    expect(lines(result)).toEqual(
      expect.arrayContaining([
        '##### Site 1 of 2 — Robin R Sample',
        '##### Site 2 of 2 — SAMPLE BARN',
        '#### Location 2 — Sample Ridge',
        '**Place:** 7 Orchard Ln, YAKIMA, WA (state as filed)',
      ]),
    );
  });
});

describe('format()', () => {
  const license: License = {
    usi: '77',
    callsign: 'KZZ\r\n077',
    isLease: true,
    licenseStatus: 'A',
    statusLabel: 'Active',
    radioServiceCode: 'HA',
    radioServiceLabel: 'Amateur\r\nService',
    serviceGroup: 'amat',
    licensee: {
      name: 'Acme\r\nRadio\nClub',
      redacted: false,
      role: 'lessee',
      city: 'NEW\rYORK',
      state: 'NY',
    },
    amateur: { trusteeCallsign: 'KZ1AAA', trusteeName: 'Trustee\r\nPerson' },
    market: {
      marketCode: 'BTA001',
      marketName: 'Fargo\r\nMoorhead, ND-MN',
      channelBlock: 'A\n1',
      blocks: [],
    },
    leasedFrom: [{ callsign: 'KZZ\n801', usi: '2001' }],
    leases: [{ callsign: 'L000\r000009', usi: '2009', licenseStatus: 'A' }],
    leaseCount: 30,
  };
  const location: Location = {
    locationNumber: 1,
    locationTypeCode: 'F',
    latitude: 47.5,
    longitude: -122.25,
    coordinatesDms: '47-30-0 N\r\n122-15-0 W',
    structureType: 'TOW\r\nER',
    address: '1 Tower\r\nRd',
    city: 'SEA\nTTLE',
    county: 'KI\rNG',
    state: 'WA',
    stateFromCoordinates: false,
    name: 'Seattle\r\nHill',
    antennas: [
      {
        antennaNumber: 1,
        make: 'ANT\r\nCO',
        model: 'A-\n100',
        frequencies: [
          {
            frequencyMhz: 152.24,
            transmitterMake: 'TX\r\nCO',
            transmitterModel: 'T\n1',
            emissions: ['11K2F3E'],
          },
        ],
      },
    ],
  };

  it('flattens CR/LF in every registry text slot so each stays on its line', () => {
    const rendered = formattedText(
      getLicense.format?.({
        found: true,
        license,
        technicalRetained: true,
        locations: [location],
        otherCallsignRecords: [],
      }),
    );
    expect(rendered).not.toContain('\r');
    const rows = rendered.split('\n');
    for (const line of [
      '## KZZ 077 · USI 77',
      '**Status:** A (Active) · **Service:** HA (Amateur Service) · **Group:** amat · **Lease:** yes',
      '**Lessee:** Acme Radio Club · **Redacted:** no · **Role:** lessee · **City:** NEW YORK · **State:** NY',
      '**Trustee callsign:** KZ1AAA · **Trustee name:** Trustee Person',
      '**Market:** BTA001 — Fargo Moorhead, ND-MN · **Channel block:** A 1',
      '**Leased from:** KZZ 801 (USI 2001)',
      '**Leases:** 30 (1 listed)',
      '- L000 000009 · USI 2009 · status A',
      '#### Location 1 — Seattle Hill',
      '**Type:** F · **Coordinates:** 47.5, -122.25 · **Filed DMS:** 47-30-0 N 122-15-0 W',
      '**Place:** 1 Tower Rd, SEA TTLE, KI NG, WA (state as filed)',
      '**Structure:** TOW ER',
      '**Antenna 1** · **Make:** ANT CO · **Model:** A- 100',
      '| 152.24 | — | — | — | — | — | — | TX CO T 1 | 11K2F3E |',
    ]) {
      expect(rows).toContain(line);
    }
  });

  it('flattens CR/LF in a candidate callsign on a miss', () => {
    const rendered = formattedText(
      getLicense.format?.({
        found: false,
        guidance: 'No record.',
        candidates: [{ callsign: 'KZZ\r\n901', usi: '1001', licenseStatus: 'A' }],
      }),
    );
    expect(rendered).not.toContain('\r');
    expect(rendered.split('\n')).toContain('- KZZ 901 · USI 1001 · status A');
  });

  it('escapes | and \\ in the transmitter, class, and emissions cells of the frequency table', () => {
    const rendered = formattedText(
      getLicense.format?.({
        found: true,
        license,
        technicalRetained: true,
        locations: [
          {
            locationNumber: 1,
            antennas: [
              {
                antennaNumber: 1,
                frequencies: [
                  {
                    frequencyMhz: 6175,
                    upperMhz: 6180,
                    bandwidthMhz: 30,
                    stationClass: 'FX|O',
                    powerOutputW: 1,
                    erpW: 2,
                    eirpDbm: 55.5,
                    transmitterMake: 'Acme|Radio',
                    transmitterModel: 'M\\1',
                    emissions: ['30M0D7W', '10|M0'],
                  },
                ],
              },
            ],
          },
        ],
        otherCallsignRecords: [],
      }),
    );
    const row = rendered.split('\n').find((line) => line.startsWith('| 6175 '));
    expect(row).toBe(
      '| 6175 | 6180 | 30 | FX\\|O | 1 | 2 | 55.5 | Acme\\|Radio M\\\\1 | 30M0D7W, 10\\|M0 |',
    );
    expect(row?.split(/(?<!\\)\|/)).toHaveLength(11);
  });

  it('tells a licensee ULS never filed apart from a redacted one', () => {
    const render = (redacted: boolean) =>
      formattedText(
        getLicense.format?.({
          found: true,
          license: { ...license, licensee: { name: null, redacted, role: 'licensee' } },
          technicalRetained: false,
          locations: [],
          otherCallsignRecords: [],
        }),
      ).split('\n');
    expect(render(false)).toContain(
      '**Licensee:** Not on file · **Redacted:** no · **Role:** licensee',
    );
    expect(render(true)).toContain(
      '**Licensee:** Redacted (individual licensee) · **Redacted:** yes · **Role:** licensee',
    );
  });

  it('describes antennaTypeCode with the codes and labels list_reference serves', () => {
    const schema = JSON.stringify(z.toJSONSchema(getLicense.output));
    const described = /"antennaTypeCode":\{[^}]*"description":"([^"]*)"/.exec(schema)?.[1];
    for (const [code, label] of Object.entries(ANTENNA_TYPES)) {
      expect(described).toContain(`${code} ${label}`);
    }
  });

  it('says "not filed" for a location that filed no coordinates (typical of mobile locations)', () => {
    const rendered = formattedText(
      getLicense.format?.({
        found: true,
        license,
        technicalRetained: true,
        locations: [{ locationNumber: 2, locationTypeCode: 'M', antennas: [] }],
        otherCallsignRecords: [],
      }),
    );
    expect(rendered).not.toContain('not valid as filed');
    expect(rendered.split('\n')).toContain('**Type:** M · **Coordinates:** not filed');
  });
});
