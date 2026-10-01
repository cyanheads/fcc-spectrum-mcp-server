/**
 * @fileoverview Tests for the `fcc-spectrum://license/{callsign}` resource over the fixture
 * index: its definition metadata (no `list`), callsign normalization and rejection in
 * `params`, the declared `index_not_ready` and `license_not_found` contracts, parity with the
 * record `fcc_spectrum_get_license` returns, the frequency-row counts under its fixed cap of
 * 100, redaction on and off, and registry text kept verbatim in the JSON body.
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
import { widePagingWeekly } from '../fixtures/uls-fixtures.js';
import {
  buildFixtureIndex,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

/** The JSON body the handler builds: a found service result plus `dataAsOf`. */
type ResourceResult = Omit<Extract<GetLicenseResult, { found: true }>, 'found'> & {
  dataAsOf: string;
};
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
      });
      expect(Object.keys(result).sort()).toEqual([
        'dataAsOf',
        'frequenciesShown',
        'frequencyTotal',
        'license',
        'locations',
        'otherCallsignRecords',
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
        market: { marketCode: 'BTA144', blocks: [{ lowMhz: 2496, highMhz: 2502 }] },
      });
    });
  });

  describe('redaction', () => {
    it("withholds an individual's name and site address while redacting", async () => {
      const result = await read('KZZ903');
      expect(result.license.licensee).toMatchObject({ name: null, redacted: true });
      expect(result.locations[0]).not.toHaveProperty('address');
      expect(JSON.stringify(result)).not.toContain('Pat Q Example');
      expect(JSON.stringify(result)).not.toContain('42 Private Lane');
    });

    it("returns an individual's name and site address with redaction off", async () => {
      await useIndex(fixture.mirrorDir, { redactIndividuals: false });
      const result = await read('KZZ903');
      expect(result.license.licensee).toMatchObject({ name: 'Pat Q Example', redacted: false });
      expect(result.locations[0]?.address).toBe('42 Private Lane');
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
    expect(result).toMatchObject({ frequenciesShown: 100, frequencyTotal: 1001 });
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
