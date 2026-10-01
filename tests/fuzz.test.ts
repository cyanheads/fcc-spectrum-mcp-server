/**
 * @fileoverview Fuzz tests over the fixture index: every tool and the license resource take
 * inputs generated from their schemas, plus adversarial ones, without an unhandled throw, a
 * stack trace or filesystem path in an error, or prototype pollution.
 * @module tests/fuzz.test
 */

import { fuzzResource, fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { licenseResource } from '@/mcp-server/resources/definitions/license.resource.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { releaseIndex, useIndex } from './fixtures/tool-harness.js';
import { buildFixtureIndex, type FixtureIndex } from './fixtures/uls-index.js';

let fixture: FixtureIndex;

beforeAll(async () => {
  fixture = await buildFixtureIndex();
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
