/**
 * @fileoverview Fuzz tests over the fixture index: every tool and the license resource take
 * inputs generated from their schemas, plus adversarial ones, without an unhandled throw, a
 * stack trace or filesystem path in an error, or prototype pollution.
 * @module tests/fuzz.test
 */

import { join } from 'node:path';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { fuzzResource, fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { licenseResource } from '@/mcp-server/resources/definitions/license.resource.js';
import { findTransmitters } from '@/mcp-server/tools/definitions/find-transmitters.tool.js';
import { getLicense } from '@/mcp-server/tools/definitions/get-license.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchFrequencies } from '@/mcp-server/tools/definitions/search-frequencies.tool.js';
import { searchLicenses } from '@/mcp-server/tools/definitions/search-licenses.tool.js';
import { createUlsStore } from '@/services/uls/schema.js';
import { contractText, releaseIndex, useIndex } from './fixtures/tool-harness.js';
import { DATA_QUALITY_WEEKLY } from './fixtures/uls-fixtures.js';
import { buildFixtureIndex, type FixtureIndex } from './fixtures/uls-index.js';

let fixture: FixtureIndex;

beforeAll(async () => {
  fixture = await buildFixtureIndex({ weekly: { paging: DATA_QUALITY_WEEKLY } });
  await useIndex(fixture.mirrorDir);
});

afterAll(async () => {
  await releaseIndex();
  await fixture.dispose();
});

describe('fuzz', () => {
  it.each(allToolDefinitions.map((definition) => [definition.name, definition] as const))(
    '%s survives valid and adversarial inputs',
    async (_name, definition) => {
      const report = await fuzzTool(definition, { numRuns: 100 });
      expect(report.crashes).toEqual([]);
      expect(report.leaks).toEqual([]);
      expect(report.prototypePollution).toBe(false);
    },
  );

  it('the license resource survives valid and adversarial params', async () => {
    const report = await fuzzResource(licenseResource, { numRuns: 100 });
    expect(report.crashes).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.prototypePollution).toBe(false);
  });
});

describe('bounded positive-integer output budgets', () => {
  let large: FixtureIndex;
  beforeAll(async () => {
    large = await buildFixtureIndex();
    const store = createUlsStore(join(large.mirrorDir, large.generation));
    try {
      (await store.raw()).exec(`
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<250)
        INSERT INTO licenses (usi,callsign,license_status,radio_service_code,service_group)
        SELECT 900000+x,'B'||printf('%06d',x),'A','CD','paging' FROM n;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<120)
        INSERT INTO locations (usi,location_number,site_seq,location_type,lat,lon)
        SELECT 900001,x,1,'F',47+x/10000.0,-122 FROM n;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300)
        INSERT INTO frequencies (usi,location_number,antenna_number,freq_seq_id,class_station,frequency_mhz,occ_low,occ_high,band_class)
        SELECT 900001,1,1,x,'FXO',10000+x,10000+x,10000+x,-14 FROM n;
        WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<120)
        INSERT INTO frequencies (usi,location_number,antenna_number,freq_seq_id,class_station,frequency_mhz,occ_low,occ_high,band_class)
        SELECT 900001,x,1,1,'ZZUNKNOWN',10500,10500,10500,-14 FROM n;
      `);
    } finally {
      await store.close();
    }
  });
  beforeEach(async () => {
    await useIndex(large.mirrorDir);
  });
  afterAll(async () => {
    await releaseIndex();
    await large.dispose();
  });

  it.each([101, 1000000])(
    'preserves every license and cursor across clamped limit %i',
    async (requested) => {
      let cursor: string | undefined;
      const seen: string[] = [];
      for (let n = 0; n < 4; n++) {
        const input = { radio_service: 'CD', status: 'any', ...(cursor && { cursor }) };
        const exact = await runToolContract(searchLicenses, { ...input, limit: 100 });
        const result = await runToolContract(searchLicenses, { ...input, limit: requested });
        expect(result.isError).toBeFalsy();
        const { notice: _expectedNotice, ...baseline } = exact.structuredContent as Record<
          string,
          unknown
        >;
        const { notice, ...actual } = result.structuredContent as Record<string, unknown>;
        expect(actual).toEqual(baseline);
        const rows = actual.licenses as { usi: string }[];
        expect(rows.length).toBeLessThanOrEqual(100);
        expect(notice).toContain(`limit ${requested} was clamped to 100`);
        expect(contractText(result)).toContain(String(notice));
        seen.push(...rows.map((row) => row.usi));
        cursor = actual.nextCursor as string | undefined;
        if (!cursor) break;
      }
      expect(cursor).toBeUndefined();
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.filter((usi) => Number(usi) > 900000)).toHaveLength(250);
    },
  );

  it.each([
    [101, 51],
    [1000000, 1000000],
  ])(
    'retains dual-clamp notices and per-site ceiling throughout nearby pages (%i, %i)',
    async (limit, max_frequencies_per_site) => {
      let cursor: string | undefined;
      const seen: number[] = [];
      for (let n = 0; n < 3; n++) {
        const input = {
          latitude: 47,
          longitude: -122,
          radius_km: 5,
          frequency_low: 10000,
          frequency_high: 11000,
          ...(cursor && { cursor }),
        };
        const exact = await runToolContract(findTransmitters, {
          ...input,
          limit: 100,
          max_frequencies_per_site: 50,
        });
        const result = await runToolContract(findTransmitters, {
          ...input,
          limit,
          max_frequencies_per_site,
        });
        expect(result.isError).toBeFalsy();
        const { notice: baselineNotice, ...baseline } = exact.structuredContent as Record<
          string,
          unknown
        >;
        const { notice, ...actual } = result.structuredContent as Record<string, unknown>;
        expect(actual).toEqual(baseline);
        const sites = actual.sites as {
          locationNumber: number;
          frequencies: { stationClasses: string[] }[];
          frequencyCount: number;
        }[];
        expect(sites.length).toBe(n === 0 ? 100 : 20);
        for (const site of sites) expect(site.frequencies.length).toBeLessThanOrEqual(50);
        if (n === 0) {
          expect(sites[0]?.frequencyCount).toBe(300);
          expect(sites[0]?.frequencies).toHaveLength(50);
        }
        expect(notice).toContain(`limit ${limit} was clamped to 100`);
        expect(notice).toContain(
          `max_frequencies_per_site ${max_frequencies_per_site} was clamped to 50`,
        );
        if (baselineNotice) expect(notice).toContain(baselineNotice);
        expect(contractText(result)).toContain(String(notice));
        seen.push(...sites.map((site) => site.locationNumber));
        cursor = actual.nextCursor as string | undefined;
        if (!cursor) break;
      }
      expect(cursor).toBeUndefined();
      expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    },
  );

  it.each([201, 1000000])(
    'preserves frequency rows, unknown classes, and continuation at clamped limit %i',
    async (requested) => {
      let cursor: string | undefined;
      const seen: number[] = [];
      const unknownLocations: number[] = [];
      for (let n = 0; n < 3; n++) {
        const input = {
          frequency_low: 10000,
          frequency_high: 11000,
          kind: 'site',
          ...(cursor && { cursor }),
        };
        const exact = await runToolContract(searchFrequencies, { ...input, limit: 200 });
        const result = await runToolContract(searchFrequencies, { ...input, limit: requested });
        expect(result.isError).toBeFalsy();
        const { notice: baselineNotice, ...baseline } = exact.structuredContent as Record<
          string,
          unknown
        >;
        const { notice, ...actual } = result.structuredContent as Record<string, unknown>;
        expect(actual).toEqual(baseline);
        const rows = actual.assignments as {
          frequencyMhz: number;
          locationNumber: number;
          stationClasses?: string[];
        }[];
        expect(rows.length).toBeLessThanOrEqual(200);
        expect(notice).toContain(`limit ${requested} was clamped to 200`);
        if (baselineNotice) expect(notice).toContain(baselineNotice);
        expect(contractText(result)).toContain(String(notice));
        seen.push(...rows.map((row) => row.frequencyMhz));
        if (rows.some((row) => row.frequencyMhz === 10500)) {
          const unknown = rows.filter((row) => row.frequencyMhz === 10500);
          for (const row of unknown) expect(row.stationClasses).toEqual(['ZZUNKNOWN']);
          unknownLocations.push(...unknown.map((row) => row.locationNumber));
          const sections = contractText(result).split('\n### ').slice(1);
          const renderedUnknown = sections.filter((section) => section.startsWith('10500 MHz ·'));
          expect(renderedUnknown).toHaveLength(unknown.length);
          for (const [i, section] of renderedUnknown.entries()) {
            expect(section.split('\n').find((line) => line.startsWith('- **Site:**'))).toMatch(
              new RegExp(`^\\- \\*\\*Site:\\*\\* location ${unknown[i]!.locationNumber} · `),
            );
            expect(section.split('\n')).toContain('- **Station classes:** ZZUNKNOWN');
          }
        }
        cursor = actual.nextCursor as string | undefined;
        if (!cursor) break;
      }
      expect(cursor).toBeUndefined();
      expect(seen).toHaveLength(419);
      expect(seen.slice(0, 300)).toEqual(Array.from({ length: 300 }, (_, i) => 10001 + i));
      expect(unknownLocations).toEqual(Array.from({ length: 119 }, (_, i) => i + 2));
    },
  );

  it('continues bounded scan pages under a clamped frequency budget', async () => {
    await useIndex(large.mirrorDir, {
      frequencySearch: { exactCap: 1, walkBudget: 2, windowTarget: 1 },
    });
    let cursor: string | undefined;
    for (let n = 0; n < 3; n++) {
      const input = {
        frequency_low: 10000,
        frequency_high: 11000,
        kind: 'site',
        ...(cursor && { cursor }),
      };
      const exact = await runToolContract(searchFrequencies, { ...input, limit: 200 });
      const result = await runToolContract(searchFrequencies, { ...input, limit: 1000000 });
      const { notice: baselineNotice, ...baseline } = exact.structuredContent as Record<
        string,
        unknown
      >;
      const { notice, ...actual } = result.structuredContent as Record<string, unknown>;
      expect(actual).toEqual(baseline);
      expect(actual).toMatchObject({ totalIsLowerBound: true, truncated: true });
      expect(notice).toContain('limit 1000000 was clamped to 200');
      expect(notice).toContain(baselineNotice);
      expect(contractText(result)).toContain('scan stopped partway');
      cursor = actual.nextCursor as string;
      expect(cursor).toBeDefined();
    }
  });

  it.each([0, -1, 1.5, '1000000', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid output budget %j for each field',
    (value) => {
      expect(searchLicenses.input.safeParse({ callsign: 'B000001', limit: value }).success).toBe(
        false,
      );
      expect(
        findTransmitters.input.safeParse({ latitude: 47, longitude: -122, limit: value }).success,
      ).toBe(false);
      expect(
        findTransmitters.input.safeParse({
          latitude: 47,
          longitude: -122,
          max_frequencies_per_site: value,
        }).success,
      ).toBe(false);
      expect(
        searchFrequencies.input.safeParse({ frequency_low: 10000, limit: value }).success,
      ).toBe(false);
      expect(getLicense.input.safeParse({ usi: '900001', max_frequencies: value }).success).toBe(
        false,
      );
    },
  );
});
