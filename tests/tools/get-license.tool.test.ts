/**
 * @fileoverview Tests for `fcc_spectrum_get_license` over the fixture index: the cold,
 * dangling, and malformed pointer states, `identifier_required` for every way of passing
 * neither or both identifiers, input normalization and blank inputs, hits and misses by
 * callsign and USI, the `max_frequencies` cap and its 1000-row ceiling, redaction on and off,
 * leases and market blocks, the required enrichment on the zero-result (miss) and under-cap
 * (hit) pages, and `format()` parity with registry text carrying CR/LF and `|`.
 * @module tests/tools/get-license.tool.test
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getLicense } from '@/mcp-server/tools/definitions/get-license.tool.js';
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
import { widePagingWeekly } from '../fixtures/uls-fixtures.js';
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
      expect(parsed).toEqual({ usi: '1005', max_frequencies: 100 });
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

    it('returns the USI guidance and no candidates on a USI miss', async () => {
      const result = await run({ usi: '424242' });
      expect(hit(result)).toMatchObject({
        found: false,
        guidance:
          'No record with USI 424242; USIs come from the usi field of fcc_spectrum_search_licenses, fcc_spectrum_find_transmitters, and fcc_spectrum_search_frequencies results.',
        candidates: [],
      });
      expect(lines(result)).toContain('No callsign-prefix candidates.');
    });

    it('returns no candidates for a callsign nothing starts with', async () => {
      const result = await run({ callsign: 'QQQ123' });
      expect(hit(result)).toMatchObject({ found: false, candidates: [] });
      expect(contractText(result)).toContain('No record with callsign QQQ123');
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
      expect(site).toMatchObject({ city: 'SPOKANE', state: 'WA' });
      const rendered = contractText(result);
      expect(rendered.split('\n')).toContain(
        '**Licensee:** Redacted (individual licensee) · **Redacted:** yes · **Role:** licensee · **FRN:** 0005550001 · **Applicant type:** I · **State:** WA',
      );
      expect(rendered.split('\n')).toContain('**Place:** SPOKANE, WA (state as filed)');
      expect(rendered).not.toContain('Pat Q Example');
      expect(rendered).not.toContain('42 Private Lane');
    });

    it("shows the individual's name, city, and site address with redaction off", async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = await run({ callsign: 'KZZ903' });
      const structured = hit(result);
      expect(structured.license?.licensee).toMatchObject({
        name: 'Pat Q Example',
        redacted: false,
        city: 'SPOKANE',
      });
      expect(structured.locations?.[0]?.address).toBe('42 Private Lane');
      const rendered = lines(result);
      expect(rendered).toContain(
        '**Licensee:** Pat Q Example · **Redacted:** no · **Role:** licensee · **FRN:** 0005550001 · **Applicant type:** I · **City:** SPOKANE · **State:** WA',
      );
      expect(rendered).toContain('**Place:** 42 Private Lane, SPOKANE, WA (state as filed)');
    });

    it('renders a withheld trustee name as "redacted" and shows it with redaction off', async () => {
      const redacted = await run({ callsign: 'KZ1CLB' });
      expect(hit(redacted).license?.amateur).toEqual({
        trusteeCallsign: 'KZ1AAA',
        trusteeName: null,
      });
      expect(lines(redacted)).toContain(
        '**Amateur:** · **Trustee callsign:** KZ1AAA · **Trustee name:** redacted',
      );

      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const open = await run({ callsign: 'KZ1CLB' });
      expect(hit(open).license?.amateur?.trusteeName).toBe('Trustee Person Example');
      expect(lines(open)).toContain(
        '**Amateur:** · **Trustee callsign:** KZ1AAA · **Trustee name:** Trustee Person Example',
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
        '**Amateur:** · **Operator class:** E (Amateur Extra) · **Previous callsign:** KZ1ZZZ',
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
        market: { marketCode: 'BTA144', blocks: [{ lowMhz: 2496, highMhz: 2502 }] },
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
        marketCode: 'BTA144',
        marketName: 'Fargo-Moorhead, ND-MN',
        channelBlock: 'A1',
        blocks: [
          { lowMhz: 2496, highMhz: 2502 },
          { lowMhz: 2502, highMhz: 2508 },
        ],
      });
      expect(structured.license?.leases).toEqual([
        { callsign: 'L000000001', usi: '2002', licenseStatus: 'A' },
        { callsign: 'L000000002', usi: '2004', licenseStatus: 'A' },
      ]);
      const rendered = lines(result);
      expect(rendered).toContain(
        '**Market:** BTA144 — Fargo-Moorhead, ND-MN · **Channel block:** A1',
      );
      expect(rendered).toContain('**Spectrum blocks:** 2496–2502 MHz, 2502–2508 MHz');
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
      '**Amateur:** · **Trustee callsign:** KZ1AAA · **Trustee name:** Trustee Person',
      '**Market:** BTA001 — Fargo Moorhead, ND-MN · **Channel block:** A 1',
      '**Leased from:** KZZ 801 (USI 2001)',
      '**Leases:** 30 (first 1 listed)',
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
