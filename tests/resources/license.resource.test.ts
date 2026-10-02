/**
 * @fileoverview Tests for the `fcc-spectrum://license/{callsign}` resource over the fixture
 * index: its definition metadata (no `list`), callsign normalization and rejection in
 * `params`, the declared `index_not_ready` and `license_not_found` contracts, parity with the
 * record `fcc_spectrum_get_license` returns, the frequency-row counts under its fixed cap of
 * 100, the first page of a large license with the notice naming the call that reads the rest,
 * redaction on and off (site names and addresses included, on shared location numbers too),
 * the ASR registration-number rule, and registry text kept verbatim in the JSON body.
 * @module tests/resources/license.resource.test
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { licenseResource } from '@/mcp-server/resources/definitions/license.resource.js';
import { getLicense } from '@/mcp-server/tools/definitions/get-license.tool.js';
import { POINTER_FILE, writePointer } from '@/services/uls/schema.js';
import type { GetLicenseResult } from '@/services/uls/types.js';
import { releaseIndex, successOf, useIndex } from '../fixtures/tool-harness.js';
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

/** The JSON body the handler builds: the found record's first page, `dataAsOf`, and a notice. */
type ResourceResult = Pick<
  Extract<GetLicenseResult, { found: true }>,
  | 'frequenciesShown'
  | 'frequencyTotal'
  | 'license'
  | 'locations'
  | 'locationTotal'
  | 'nextLeaseOffset'
  | 'nextLocationOffset'
  | 'otherCallsignRecords'
  | 'siteTotal'
  | 'technicalRetained'
> & { dataAsOf: string; notice?: string };
type ToolOutput = Parameters<NonNullable<typeof getLicense.format>>[0];

const DATA_AS_OF = '2026-09-27T13:44:10Z';

const { params: paramsSchema } = licenseResource;
if (!paramsSchema) throw new Error('The license resource declares no params schema.');

/** Read the resource for `callsign` the way the framework does: params parsed, then the handler. */
const read = async (callsign: unknown): Promise<ResourceResult> =>
  (await licenseResource.handler(
    paramsSchema.parse({ callsign }),
    createMockContext({ errors: licenseResource.errors }),
  )) as ResourceResult;

/** The `McpError` a read rejects with. */
async function failure(callsign: unknown): Promise<McpError> {
  const error = await read(callsign).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

/** Assert `error` is the declared contract entry for `reason`. */
function expectReason(error: McpError, reason: string): void {
  const entry = licenseResource.errors?.find((candidate) => candidate.reason === reason);
  expect(entry, `"${reason}" is a declared reason`).toBeDefined();
  expect(error.code).toBe(entry?.code);
  expect(error.data?.reason).toBe(reason);
}

describe('definition', () => {
  it('is a JSON resource with a public one-hour cache hint and no list()', () => {
    expect(licenseResource.uriTemplate).toBe('fcc-spectrum://license/{callsign}');
    expect(licenseResource.name).toBe('fcc_spectrum_license');
    expect(licenseResource.mimeType).toBe('application/json');
    expect(licenseResource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
    expect(licenseResource.list).toBeUndefined();
  });

  it('declares index_not_ready as ServiceUnavailable and license_not_found as NotFound', () => {
    expect(licenseResource.errors?.map(({ reason, code }) => [reason, code])).toEqual([
      ['index_not_ready', JsonRpcErrorCode.ServiceUnavailable],
      ['license_not_found', JsonRpcErrorCode.NotFound],
    ]);
    expect(licenseResource.errors?.[0]).toMatchObject({ retryable: false });
  });
});

describe('params', () => {
  it.each([
    [' kzz 901/4 ', 'KZZ901'],
    ['kzz901', 'KZZ901'],
    ['l000000001', 'L000000001'],
    ['KZ1AAA/M', 'KZ1AAA'],
    ['kzz901%2F4', 'KZZ901'],
    ['kzz%20901%2fm', 'KZZ901'],
  ])('normalizes %j to %s', (raw, normalized) => {
    expect(paramsSchema.parse({ callsign: raw })).toEqual({ callsign: normalized });
  });

  it.each([
    ['an empty callsign', ''],
    ['a whitespace-only callsign', '   '],
    ['a two-character callsign', 'KZ'],
    ['an eleven-character callsign', 'KZZ12345678'],
    ['a wildcard', 'KZZ*'],
    ['a prefix-portable callsign', 'VE3/N0CALL'],
    ['a percent-encoded prefix-portable callsign', 'VE3%2FN0CALL'],
    ['a malformed percent-escape', 'KZZ%E0%A4%A'],
    ['a number', 901],
  ])('rejects %s', (_label, callsign) => {
    expect(paramsSchema.safeParse({ callsign }).success).toBe(false);
  });
});

describe('index not available', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('license-resource-cold');
  });
  afterAll(async () => {
    await releaseIndex();
    await cold.remove();
  });

  it('fails index_not_ready on a cold index, before any lookup', async () => {
    await useIndex(cold.mirrorDir);
    const error = await failure('KZZ901');
    expectReason(error, 'index_not_ready');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe('No completed index generation is published yet.');
  });

  it('fails index_not_ready when current.json names a missing generation', async () => {
    const dangling = await makeTempMirror('license-resource-dangling');
    try {
      await writePointer(dangling.mirrorDir, {
        file: 'fcc-uls-20990101T000000Z.db',
        publishedAt: '2026-09-29T20:00:00Z',
      });
      await useIndex(dangling.mirrorDir);
      expectReason(await failure('KZZ901'), 'index_not_ready');
    } finally {
      await releaseIndex();
      await dangling.remove();
    }
  });

  it('fails index_not_ready when current.json is malformed', async () => {
    const malformed = await makeTempMirror('license-resource-malformed');
    try {
      await writeFile(join(malformed.mirrorDir, POINTER_FILE), '{"file": 42');
      await useIndex(malformed.mirrorDir);
      expectReason(await failure('KZZ901'), 'index_not_ready');
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

  describe('license_not_found', () => {
    it('names the normalized callsign and lists the callsign-prefix candidates', async () => {
      const error = await failure('kzz9');
      expectReason(error, 'license_not_found');
      expect(error.message).toBe('No record with callsign KZZ9 in the indexed service groups.');
      expect(error.data?.callsign).toBe('KZZ9');
      // KZZ901 is shared by two records and is listed once.
      expect(error.data?.candidates).toEqual(['KZZ901', 'KZZ902', 'KZZ903', 'KZZ906']);
    });

    it('carries an empty candidate list when nothing starts with the callsign', async () => {
      const error = await failure('QQQ123');
      expectReason(error, 'license_not_found');
      expect(error.data).toMatchObject({ callsign: 'QQQ123', candidates: [] });
    });
  });

  describe('a hit', () => {
    it('returns the active record of a shared callsign with all four frequency rows', async () => {
      const result = await read('KZZ901');
      expect(result).toMatchObject({
        dataAsOf: DATA_AS_OF,
        technicalRetained: true,
        license: { usi: '1001', callsign: 'KZZ901', licenseStatus: 'A' },
        otherCallsignRecords: [{ usi: '1005', licenseStatus: 'E' }],
        frequenciesShown: 4,
        frequencyTotal: 4,
        locationTotal: 2,
        siteTotal: 2,
      });
      expect(Object.keys(result).sort()).toEqual([
        'dataAsOf',
        'frequenciesShown',
        'frequencyTotal',
        'license',
        'locationTotal',
        'locations',
        'otherCallsignRecords',
        'siteTotal',
        'technicalRetained',
      ]);
    });

    it.each([
      ['a shared callsign', 'KZZ901'],
      ['a lease with a market', 'L000000001'],
      ['a parent license with leases and market blocks', 'KZZ801'],
      ['an amateur club with a trustee', 'KZ1CLB'],
      ['a non-live record', 'KZZ902'],
      ['a record with invalid coordinates', 'KZZ907'],
    ])('matches the record fcc_spectrum_get_license returns for %s', async (_label, callsign) => {
      const resource = await read(callsign);
      const tool = successOf<ToolOutput & { dataAsOf: string }>(
        await runToolContract(getLicense, { callsign } as never),
      );
      expect(tool.found).toBe(true);
      expect(resource).toEqual({
        dataAsOf: tool.dataAsOf,
        license: tool.license,
        technicalRetained: tool.technicalRetained,
        locations: tool.locations,
        locationTotal: tool.locationTotal,
        siteTotal: tool.siteTotal,
        otherCallsignRecords: tool.otherCallsignRecords,
        frequenciesShown: expect.any(Number),
        frequencyTotal: expect.any(Number),
      });
    });

    it('reports a non-live record with no sites and zero frequency rows', async () => {
      expect(await read('KZZ902')).toMatchObject({
        technicalRetained: false,
        locations: [],
        license: { usi: '1002', licenseStatus: 'C' },
        frequenciesShown: 0,
        frequencyTotal: 0,
      });
    });

    it('returns a lease with its lessee, the license it is leased from, and its block', async () => {
      const result = await read('l000000001');
      expect(result.license).toMatchObject({
        usi: '2002',
        isLease: true,
        licensee: { name: 'Leaseholder Wireless LLC', role: 'lessee' },
        leasedFrom: [{ callsign: 'KZZ801', usi: '2001' }],
        market: { marketCode: 'BTA138', blocks: [{ lowMhz: 2496, highMhz: 2502 }] },
      });
    });
  });

  describe('redaction', () => {
    it("withholds an individual's name, site address, and site name while redacting", async () => {
      const result = await read('KZZ903');
      expect(result.license.licensee).toMatchObject({ name: null, redacted: true });
      expect(result.locations[0]).not.toHaveProperty('address');
      expect(result.locations[0]).not.toHaveProperty('name');
      expect(JSON.stringify(result)).not.toContain('Pat Q Example');
      expect(JSON.stringify(result)).not.toContain('42 Private Lane');
    });

    it("returns an individual's name, site address, and site name with redaction off", async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = await read('KZZ903');
      expect(result.license.licensee).toMatchObject({ name: 'Pat Q Example', redacted: false });
      expect(result.locations[0]).toMatchObject({
        address: '42 Private Lane',
        name: 'Pat Q Example',
      });
    });

    it("returns an organization's site name while redacting", async () => {
      expect((await read('KZZ901')).locations[0]?.name).toBe('Seattle Hill');
    });
  });

  it('keeps a CR in registry text verbatim and escaped in the JSON body', async () => {
    const result = await read('KZZ907');
    expect(result.license.licensee.name).toBe('Carriage\rReturn Paging');
    const body = JSON.stringify(result);
    expect(body).toContain('Carriage\\rReturn Paging');
    expect(JSON.parse(body)).toEqual(result);
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

  it('withholds the name and address of each site sharing a number while redacting', async () => {
    await useIndex(individual.mirrorDir, { services: ['paging'] });
    const result = await read('KZZ521');
    const [shared, single] = result.locations;
    expect(shared?.sites).toHaveLength(2);
    for (const site of [...(shared?.sites ?? []), single]) {
      expect(site).not.toHaveProperty('name');
      expect(site).not.toHaveProperty('address');
    }
    for (const filed of ['Robin', 'Sample', 'SAMPLE', 'Orchard', 'Ridge Rd']) {
      expect(JSON.stringify(result), filed).not.toContain(filed);
    }
  });

  it('returns them with redaction off', async () => {
    await useIndex(individual.mirrorDir, { services: ['paging'], redactIndividuals: false });
    const result = await read('KZZ521');
    expect(result.locations[0]?.sites?.map((site) => site.name)).toEqual([
      'Robin R Sample',
      'SAMPLE BARN',
    ]);
    expect(result.locations[1]?.name).toBe('Sample Ridge');
  });
});

describe('an ASR field holding something other than a registration number', () => {
  let quirks: FixtureIndex;
  beforeAll(async () => {
    quirks = await buildFixtureIndex({ groups: ['paging'], weekly: { paging: QUIRKS_WEEKLY } });
    await useIndex(quirks.mirrorDir, { services: ['paging'] });
  });
  afterAll(async () => {
    await releaseIndex();
    await quirks.dispose();
  });

  it('is omitted, while a seven-digit registration number is kept', async () => {
    const result = await read('KZZ505');
    const [shared, single] = result.locations;
    for (const site of shared?.sites ?? []) expect(site).not.toHaveProperty('asrNumber');
    expect(single?.asrNumber).toBe('1012345');
    expect(JSON.stringify(result)).not.toContain('N/A');
    expect(JSON.stringify(result)).not.toContain('9999999');
    expect((await read('KZZ502')).locations[0]).not.toHaveProperty('asrNumber');
  });
});

describe('the 100-row cap', () => {
  let wide: FixtureIndex;
  beforeAll(async () => {
    wide = await buildFixtureIndex({ weekly: { paging: widePagingWeekly(1001) } });
    await useIndex(wide.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await wide.dispose();
  });

  it('returns 100 of 1001 frequency rows, matching the tool at its default cap', async () => {
    const result = await read('KZZ401');
    expect(result).toMatchObject({
      frequenciesShown: 100,
      frequencyTotal: 1001,
      notice:
        'Lists 100 of 1001 frequency rows at these locations; call fcc_spectrum_get_license with usi "4001" and a higher max_frequencies (up to 1000) for the rest.',
    });
    const rows = result.locations.flatMap((location) =>
      location.antennas.flatMap((antenna) => antenna.frequencies),
    );
    expect(rows).toHaveLength(100);
    const tool = successOf<ToolOutput & { shown: number; truncated: boolean }>(
      await runToolContract(getLicense, { callsign: 'KZZ401' } as never),
    );
    expect(tool).toMatchObject({ shown: 100, truncated: true });
    expect(result.locations).toEqual(tool.locations);
  });
});

describe('a large license', () => {
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
    await useIndex(sprawl.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await sprawl.dispose();
  });

  it('holds the first page and names the fcc_spectrum_get_license calls for the rest', async () => {
    const result = await read('KZZ701');
    expect(result).toMatchObject({
      locationTotal: 60,
      siteTotal: 62,
      nextLocationOffset: 48,
      nextLeaseOffset: 100,
      notice:
        'Lists 48 of 60 locations; call fcc_spectrum_get_license with usi "7001" and location_offset 48 for the rest. Lists 100 of 130 leases; call fcc_spectrum_get_license with usi "7001" and lease_offset 100 for the rest.',
    });
    expect(result.locations).toHaveLength(48);
    expect(result.license.leases).toHaveLength(100);
    const tool = successOf<ToolOutput>(
      await runToolContract(getLicense, { callsign: 'KZZ701' } as never),
    );
    expect(result.locations).toEqual(tool.locations);
  });
});
