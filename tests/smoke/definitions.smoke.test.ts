/**
 * @fileoverview Smoke coverage for every registered definition.
 * @module tests/smoke/definitions.smoke.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { getUlsIndexService, initUlsIndexService } from '@/services/uls/uls-index-service.js';

describe('registered definition smoke test', () => {
  const mirrorDir = mkdtempSync(join(tmpdir(), 'fcc-spectrum-smoke-'));

  beforeAll(() => {
    initUlsIndexService({ mirrorDir, redactIndividuals: true, services: ['paging'] });
  });

  afterAll(async () => {
    await getUlsIndexService().close();
    rmSync(mirrorDir, { recursive: true, force: true });
  });

  it('registers the five fcc_spectrum tools', () => {
    expect(allToolDefinitions.map((definition) => definition.name)).toEqual([
      'fcc_spectrum_search_licenses',
      'fcc_spectrum_get_license',
      'fcc_spectrum_find_transmitters',
      'fcc_spectrum_search_frequencies',
      'fcc_spectrum_list_reference',
    ]);
  });

  it('decodes a vocabulary topic and reports a cold index', async () => {
    const ctx = createMockContext();
    const statuses = await listReference.handler(
      listReference.input.parse({ topic: 'license_statuses' }),
      ctx,
    );
    expect(statuses).toEqual(expect.schemaMatching(listReference.output));
    expect(statuses.entries?.find((entry) => entry.code === 'A')?.label).toBe('Active');

    const coverageCtx = createMockContext();
    const coverage = await listReference.handler(
      listReference.input.parse({ topic: 'coverage', filter: '' }),
      coverageCtx,
    );
    expect(coverage.index).toEqual({ ready: false, status: 'none' });
    expect(getEnrichment(coverageCtx).notice).toContain('mirror:init');
    expect(listReference.format?.(coverage)[0]).toMatchObject({ type: 'text' });
  });
});
