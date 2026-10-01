/**
 * @fileoverview Tests for `fcc_spectrum_list_reference`: vocabulary topics and coverage on a
 * cold, a malformed-pointer, and a warm index, the radio-service filter, input validation and
 * both surfaces through `runToolContract`, and `format()` keeping registry text out of inline
 * markdown slots.
 * @module tests/tools/list-reference.tool.test
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { LICENSE_STATUSES, RADIO_SERVICES } from '@/services/uls/codes.js';
import { LOCK_FILE, POINTER_FILE } from '@/services/uls/schema.js';
import { initUlsIndexService } from '@/services/uls/uls-index-service.js';
import {
  buildFixtureIndex,
  FIXTURE_GROUPS,
  type FixtureIndex,
  makeTempMirror,
  type TempMirror,
} from '../fixtures/uls-index.js';

type Output = Awaited<ReturnType<typeof listReference.handler>>;

const RADIO_SERVICE_COUNT = Object.keys(RADIO_SERVICES).length;

/** Point the tool's service accessor at `mirrorDir`. */
function useIndex(mirrorDir: string, redactIndividuals = true) {
  return initUlsIndexService({
    mirrorDir,
    pointerCheckMs: 0,
    redactIndividuals,
    services: FIXTURE_GROUPS,
  });
}

async function call(input: Record<string, unknown>) {
  const ctx = createMockContext();
  const result = await listReference.handler(listReference.input.parse(input), ctx);
  return { result, enrichment: getEnrichment(ctx) as { dataAsOf?: string; notice?: string } };
}

const text = (result: { content?: unknown[] }) =>
  ((result.content ?? []) as { text?: string }[]).map((block) => block.text ?? '').join('\n');

describe('cold index', () => {
  let cold: TempMirror;
  beforeAll(async () => {
    cold = await makeTempMirror('list-ref-cold');
  });
  afterAll(async () => {
    await cold.remove();
  });

  it('decodes vocabulary topics without the index', async () => {
    const service = useIndex(cold.mirrorDir);
    const statuses = await call({ topic: 'license_statuses' });
    expect(statuses.result.entries).toHaveLength(Object.keys(LICENSE_STATUSES).length);
    expect(statuses.result.entries?.[0]).toEqual({ code: 'A', label: 'Active' });
    expect(statuses.enrichment.dataAsOf).toBeUndefined();
    const services = await call({ topic: 'radio_services' });
    expect(services.result.entries).toHaveLength(RADIO_SERVICE_COUNT);
    expect(services.result.entries?.some((entry) => 'group' in entry)).toBe(false);
    await service.close();
  });

  it('reports coverage none with a notice naming the configured groups', async () => {
    const service = useIndex(cold.mirrorDir);
    const { result, enrichment } = await call({ topic: 'coverage' });
    expect(result.index).toEqual({ ready: false, status: 'none' });
    expect(enrichment.notice).toBe(
      'The local ULS index has not been built yet, so the search tools cannot answer; an operator must run the mirror:init script once. Configured service groups: paging, mdsitfs, amat.',
    );
    await service.close();
  });

  it('reports coverage building while a live process holds the lock', async () => {
    const building = await makeTempMirror('list-ref-building');
    const service = useIndex(building.mirrorDir);
    try {
      await writeFile(
        join(building.mirrorDir, LOCK_FILE),
        JSON.stringify({ pid: process.pid, mode: 'init', startedAt: '2026-09-29T20:00:00Z' }),
      );
      const contract = await runToolContract(listReference, { topic: 'coverage' });
      expect(contract.isError).toBeFalsy();
      const structured = contract.structuredContent as Output & { notice?: string };
      expect(structured.index).toEqual({ ready: false, status: 'building' });
      expect(structured.notice).toContain('published yet (a build is running)');
      expect(text(contract)).toContain('published yet (a build is running)');
      expect(text(contract)).toContain('**Status:** building');
    } finally {
      await service.close();
      await building.remove();
    }
  });

  it('keeps working over a malformed current.json, reporting it as the coverage error', async () => {
    const malformed = await makeTempMirror('list-ref-malformed');
    const service = useIndex(malformed.mirrorDir);
    try {
      await writeFile(join(malformed.mirrorDir, POINTER_FILE), '{"file": 42');
      const contract = await runToolContract(listReference, { topic: 'coverage' });
      expect(contract.isError).toBeFalsy();
      const structured = contract.structuredContent as Output & { dataAsOf?: string };
      expect(structured.index).toEqual({
        ready: false,
        status: 'none',
        error: 'current.json is not a valid generation pointer; rerun mirror:init to republish it.',
      });
      expect(structured.dataAsOf).toBeUndefined();
      expect(text(contract)).toContain('> current.json is not a valid generation pointer');
      const statuses = await call({ topic: 'license_statuses' });
      expect(statuses.result.entries).toHaveLength(Object.keys(LICENSE_STATUSES).length);
    } finally {
      await service.close();
      await malformed.remove();
    }
  });
});

describe('warm index', () => {
  let fixture: FixtureIndex;
  beforeAll(async () => {
    fixture = await buildFixtureIndex();
    useIndex(fixture.mirrorDir);
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  it('adds group and record counts to radio services, and lists an unlabeled indexed code', async () => {
    const { result, enrichment } = await call({ topic: 'radio_services' });
    expect(enrichment.dataAsOf).toBe('2026-09-27T13:44:10Z');
    expect(result.entries).toHaveLength(RADIO_SERVICE_COUNT + 1);
    const byCode = new Map(result.entries?.map((entry) => [entry.code, entry]));
    expect(byCode.get('CD')).toEqual({
      code: 'CD',
      label: 'Paging and Radiotelephone',
      group: 'paging',
      indexedRecords: 7,
    });
    expect(byCode.get('ZQ')).toEqual({
      code: 'ZQ',
      label: 'ZQ',
      group: 'paging',
      indexedRecords: 1,
    });
    expect(byCode.get('CL')).toEqual({ code: 'CL', label: 'Cellular' });
    const codes = result.entries?.map((entry) => entry.code) ?? [];
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
  });

  it('reports coverage with group counts and no notice', async () => {
    const { result, enrichment } = await call({ topic: 'coverage' });
    expect(result.index).toMatchObject({ ready: true, status: 'ready' });
    expect(result.groups?.find((group) => group.group === 'paging')).toMatchObject({
      indexed: true,
      records: 8,
      sites: 7,
      frequencies: 10,
    });
    expect(result.redactIndividuals).toBe(true);
    expect(enrichment.notice).toBeUndefined();
  });

  it.each([
    ['paging radiotelephone', ['CD']],
    ['RADIOTELEPHONE paging', ['CD']],
    ['Pâging radiotéléphone', ['CD']],
    ['zq', ['ZQ']],
  ])('filters radio services by every word of %j', async (filter, expected) => {
    const { result, enrichment } = await call({ topic: 'radio_services', filter });
    expect(result.entries?.map((entry) => entry.code)).toEqual(expected);
    expect(enrichment.notice).toBeUndefined();
  });

  it('explains a filter that matched nothing', async () => {
    const { result, enrichment } = await call({
      topic: 'radio_services',
      filter: 'paging cellular',
    });
    expect(result.entries).toEqual([]);
    expect(enrichment.notice).toBe(
      `No radio service code or label contains every word of "paging cellular"; drop a word, or call without filter to list all ${RADIO_SERVICE_COUNT + 1} codes.`,
    );
  });

  it('ignores a filter on another topic and says so', async () => {
    const { result, enrichment } = await call({ topic: 'license_statuses', filter: 'active' });
    expect(result.entries).toHaveLength(7);
    expect(enrichment.notice).toBe(
      'filter applies to topic "radio_services" only; all 7 license statuses are listed.',
    );
  });

  it.each(['', '   '])('reads a blank filter (%j) as unset', async (filter) => {
    expect(listReference.input.parse({ topic: 'radio_services', filter }).filter).toBeUndefined();
    const { result, enrichment } = await call({ topic: 'radio_services', filter });
    expect(result.entries).toHaveLength(RADIO_SERVICE_COUNT + 1);
    expect(enrichment.notice).toBeUndefined();
  });

  it.each([
    [' License_Statuses ', 'license_statuses'],
    ['COVERAGE', 'coverage'],
  ])('case-folds the topic %j', (topic, expected) => {
    expect(listReference.input.parse({ topic }).topic).toBe(expected);
  });

  it.each([
    ['an unknown topic', { topic: 'callsigns' }],
    ['a 201-character filter', { topic: 'radio_services', filter: 'x'.repeat(201) }],
  ])('rejects %s with InvalidParams', async (_label, input) => {
    const result = await runToolContract(listReference, input as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });

  it('carries the notice and dataAsOf on both surfaces for a zero-result filter', async () => {
    const result = await runToolContract(listReference, {
      topic: 'radio_services',
      filter: 'zzzz qqqq',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & { dataAsOf?: string; notice?: string };
    expect(structured.entries).toEqual([]);
    expect(structured.dataAsOf).toBe('2026-09-27T13:44:10Z');
    expect(structured.notice).toContain('"zzzz qqqq"');
    expect(text(result)).toContain('0 entries');
    expect(text(result)).toContain('"zzzz qqqq"');
    expect(text(result)).toContain('2026-09-27T13:44:10Z');
  });

  it('renders every code and label of a populated page on both surfaces', async () => {
    const result = await runToolContract(listReference, {
      topic: 'radio_services',
      filter: 'band',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & { dataAsOf?: string };
    expect(structured.entries?.length).toBeGreaterThan(1);
    expect(structured.entries?.length).toBeLessThan(RADIO_SERVICE_COUNT);
    const rendered = text(result);
    expect(rendered).toContain(`${structured.entries?.length} entries`);
    for (const entry of structured.entries ?? []) {
      expect(rendered).toContain(`| ${entry.code} |`);
      expect(rendered).toContain(entry.label);
    }
    expect(rendered).toContain('2026-09-27T13:44:10Z');
  });
});

describe('format()', () => {
  /** The text of the one block `format()` renders. */
  const formatText = (output: Output): string => {
    const blocks = listReference.format?.(output) ?? [];
    expect(blocks).toHaveLength(1);
    return (blocks[0] as { text: string }).text;
  };

  it('keeps a label with CR/LF and a pipe on one table row', () => {
    const rendered = formatText({
      topic: 'radio_services',
      entries: [{ code: 'Z|Q', label: 'Line one\r\nline two | piped', group: 'paging' }],
    });
    const row = rendered.split('\n').find((line) => line.startsWith('| Z'));
    expect(row).toBe('| Z\\|Q | Line one line two \\| piped | paging | — |');
    expect(rendered).not.toMatch(/two \| piped/);
  });

  it('counts one entry in the singular and several in the plural', () => {
    const entry = { code: 'A', label: 'Active' };
    expect(formatText({ topic: 'license_statuses', entries: [entry] }).split('\n')).toContain(
      '1 entry',
    );
    expect(
      formatText({ topic: 'license_statuses', entries: [entry, entry] }).split('\n'),
    ).toContain('2 entries');
  });

  it('renders a multi-line index error as quoted lines', () => {
    const rendered = formatText({
      topic: 'coverage',
      index: { ready: false, status: 'none', error: 'first line\r\n## not a heading\nthird' },
      groups: [{ group: 'paging', indexed: false }],
      redactIndividuals: true,
    });
    expect(rendered).toContain('**Last error:**\n> first line\n> ## not a heading\n> third');
    expect(rendered).toContain('| paging | no | — | — | — | — |');
    expect(rendered).toContain('**Redact individuals:** yes');
  });
});
