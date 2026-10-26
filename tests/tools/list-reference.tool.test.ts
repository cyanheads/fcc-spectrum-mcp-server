/**
 * @fileoverview Tests for `fcc_spectrum_list_reference`: vocabulary topics and coverage on a
 * cold, a malformed-pointer, and a warm index (with incomplete antenna or path coverage), the
 * radio-service filter, input validation and
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
import { createUlsStore, LOCK_FILE, POINTER_FILE } from '@/services/uls/schema.js';
import { initUlsIndexService, PATH_COVERAGE_NOTICE } from '@/services/uls/uls-index-service.js';
import { markdown, renderedText } from '../fixtures/tool-harness.js';
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
  const ctx = createMockContext({ errors: listReference.errors });
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

  it('discloses an ignored coverage filter alongside cold-index guidance on both surfaces', async () => {
    const service = useIndex(cold.mirrorDir);
    try {
      const result = await runToolContract(listReference, { topic: 'coverage', filter: '!!!' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('filter was not applied'),
      });
      expect(text(result)).toContain('filter was not applied');
      expect(text(result)).toContain('has not been built yet');
    } finally {
      await service.close();
    }
  });

  it.each(['!!!', '東京', '\u0301'])(
    'rejects searchable tokenless filter %j with actionable recovery',
    async (filter) => {
      const service = useIndex(cold.mirrorDir);
      try {
        const result = await runToolContract(listReference, { topic: 'radio_services', filter });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'invalid_filter',
              recovery: { hint: expect.stringContaining('ASCII letter or digit') },
            },
          },
        });
        expect(text(result)).toContain('ASCII letter or digit');
      } finally {
        await service.close();
      }
    },
  );

  it('decodes station classes on both surfaces before the index is built', async () => {
    const service = useIndex(cold.mirrorDir);
    try {
      for (const [code, label] of [
        ['FXO', 'Operational Fixed'],
        ['MO', 'Mobile'],
      ] as const) {
        const result = await runToolContract(listReference, {
          topic: 'station_classes',
          filter: code,
        } as never);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          entries: expect.arrayContaining([{ code, label }]),
        });
        expect(text(result)).toContain(`| ${code} | ${label} |`);
      }
    } finally {
      await service.close();
    }
  });

  it('keeps station-class token filtering, blanks, unknowns, and ordering consistent on both surfaces', async () => {
    const service = useIndex(cold.mirrorDir);
    try {
      const full = await runToolContract(listReference, { topic: 'station_classes' });
      const all = full.structuredContent as Output;
      expect(all.entries).toHaveLength(266);
      const codes = all.entries?.map((entry) => entry.code) ?? [];
      expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
      for (const entry of all.entries ?? [])
        expect(text(full)).toContain(`| ${entry.code} | ${entry.label} |`);
      for (const filter of ['', '  ']) {
        const blank = await runToolContract(listReference, { topic: 'station_classes', filter });
        expect(blank.structuredContent).toEqual(full.structuredContent);
        expect(text(blank)).toEqual(text(full));
      }
      for (const filter of ['fb2 relay', 'rélay!!!FB2']) {
        const filtered = await runToolContract(listReference, { topic: 'station_classes', filter });
        const entries = [
          { code: 'FB2', label: 'Mobile Relay' },
          { code: 'FB2A', label: 'Mobile Relay - Airport Terminal Use' },
          { code: 'FB2C', label: 'Mobile Relay - Interconnect' },
          { code: 'FB2I', label: 'Mobile Relay - Itinerant' },
          { code: 'FB2J', label: 'Mobil Relay - Temporary Interconnect' },
          { code: 'FB2K', label: 'Mobile Relay - Stand-by Interconnect' },
          { code: 'FB2L', label: 'Mobile Relay - Itinerant Interconnect' },
          { code: 'FB2S', label: 'Mobil Relay - Stand-by' },
          { code: 'FB2T', label: 'Mobile Relay - Temporary' },
        ];
        expect((filtered.structuredContent as Output).entries).toEqual(entries);
        expect(
          text(filtered)
            .split('\n')
            .filter((line) => /^\| FB2/.test(line)),
        ).toEqual(entries.map((entry) => `| ${entry.code} | ${entry.label} |`));
      }
      const unknown = await runToolContract(listReference, {
        topic: 'station_classes',
        filter: 'ZZUNKNOWN',
      });
      expect(unknown.structuredContent).toMatchObject({
        entries: [],
        notice: expect.stringContaining('label is unavailable'),
      });
      expect(text(unknown)).toContain('0 entries');
      expect(text(unknown)).toContain('unknown filed code remains valid and unchanged');
      const invalid = await runToolContract(listReference, {
        topic: 'station_classes',
        filter: '!!!',
      });
      expect(invalid.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_filter' } },
      });
      expect(text(invalid)).toContain('ASCII letter or digit');
    } finally {
      await service.close();
    }
  });

  it('reports coverage building while a live process holds the lock', async () => {
    const building = await makeTempMirror('list-ref-building');
    const service = useIndex(building.mirrorDir);
    try {
      await writeFile(
        join(building.mirrorDir, LOCK_FILE),
        JSON.stringify({ pid: process.pid, mode: 'init', startedAt: '2026-09-29T20:00:00Z' }),
      );
      const contract = await runToolContract(listReference, {
        topic: 'coverage',
        filter: 'paging',
      });
      expect(contract.isError).toBeFalsy();
      const structured = contract.structuredContent as Output & { notice?: string };
      expect(structured.index).toEqual({ ready: false, status: 'building' });
      expect(structured.notice).toContain('published yet (a build is running)');
      expect(text(contract)).toContain('published yet (a build is running)');
      expect(text(contract)).toContain('**Status:** building');
      expect(text(contract)).toContain('filter was not applied');
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
      const contract = await runToolContract(listReference, {
        topic: 'coverage',
        filter: 'paging',
      });
      expect(contract.isError).toBeFalsy();
      const structured = contract.structuredContent as Output & { dataAsOf?: string };
      expect(structured.index).toEqual({
        ready: false,
        status: 'none',
        error: 'current.json is not a valid generation pointer; rerun mirror:init to republish it.',
      });
      expect(structured.dataAsOf).toBeUndefined();
      expect(text(contract)).toContain('> current.json is not a valid generation pointer');
      expect(text(contract)).toContain('filter was not applied');
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
    expect(result.index).not.toHaveProperty('pathCoverageIncomplete');
  });

  it('discloses an unused warm coverage filter without altering readiness', async () => {
    const result = await runToolContract(listReference, { topic: 'coverage', filter: '東京' });
    expect(result.structuredContent).toMatchObject({
      index: { ready: true },
      notice: expect.stringContaining('filter was not applied'),
    });
    expect(text(result)).toContain('filter was not applied');
    expect(text(result)).not.toContain('has not been built yet');
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
      'filter applies to topics "radio_services" and "station_classes" only; filter was not applied, and all 7 license statuses are listed.',
    );
  });

  it('characterizes punctuation-separated accented tokens and unsupported tokenless filters', async () => {
    const matched = await runToolContract(listReference, {
      topic: 'radio_services',
      filter: 'PÂGING!!!radiotéléphone',
    });
    expect(matched.structuredContent).toMatchObject({
      entries: [
        { code: 'CD', label: 'Paging and Radiotelephone', group: 'paging', indexedRecords: 7 },
      ],
    });
    expect(text(matched)).toContain('| CD | Paging and Radiotelephone |');
    const ignored = await runToolContract(listReference, {
      topic: 'license_statuses',
      filter: '東京!!!',
    });
    expect(ignored.isError).toBeFalsy();
    expect(ignored.structuredContent).toMatchObject({
      notice: expect.stringContaining('all 7 license statuses are listed'),
    });
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

describe('incomplete antenna coverage', () => {
  let fixture: FixtureIndex;
  let service: ReturnType<typeof useIndex>;
  beforeAll(async () => {
    fixture = await buildFixtureIndex();
    const store = createUlsStore(join(fixture.mirrorDir, fixture.generation));
    (await store.raw()).exec(
      "INSERT INTO meta (key,value) VALUES ('antenna_coverage_incomplete','6')",
    );
    await store.close();
    service = useIndex(fixture.mirrorDir);
  });
  afterAll(async () => {
    await service.close();
    await fixture.dispose();
  });
  it('keeps ready true and renders the marker and rebuild recovery on both surfaces', async () => {
    const result = await runToolContract(listReference, { topic: 'coverage', filter: 'paging' });
    expect(result.structuredContent).toMatchObject({
      index: { ready: true, antennaCoverageIncomplete: true },
      notice: expect.stringContaining('daily refresh restores only licenses it replaces'),
    });
    expect(text(result)).toContain('Antenna coverage incomplete');
    expect(text(result)).toContain('mirror:init');
    expect(text(result)).toContain('filter was not applied');
    expect(text(result).match(/daily refresh restores only licenses it replaces/g)).toHaveLength(1);
  });
});

describe('incomplete path coverage', () => {
  let fixture: FixtureIndex;
  let service: ReturnType<typeof useIndex>;
  beforeAll(async () => {
    fixture = await buildFixtureIndex();
    const store = createUlsStore(join(fixture.mirrorDir, fixture.generation));
    (await store.raw()).exec(
      "INSERT INTO meta (key,value) VALUES ('path_coverage_incomplete','7')",
    );
    await store.close();
    service = useIndex(fixture.mirrorDir);
  });
  afterAll(async () => {
    await service.close();
    await fixture.dispose();
  });
  it('keeps ready true and renders the marker and rebuild recovery on both surfaces', async () => {
    const result = await runToolContract(listReference, { topic: 'coverage' });
    expect(result.structuredContent).toMatchObject({
      index: { ready: true, pathCoverageIncomplete: true },
      notice: PATH_COVERAGE_NOTICE,
    });
    expect(result.structuredContent).not.toHaveProperty('index.antennaCoverageIncomplete');
    const rendered = text(result);
    expect(rendered.split('\n')).toContain('**Path coverage incomplete:** Yes.');
    expect(rendered).not.toContain('Antenna coverage incomplete');
    expect(rendered.split(PATH_COVERAGE_NOTICE)).toHaveLength(2);
  });
});

describe('format()', () => {
  it('keeps each error line literal and terminates the quote before later output', () => {
    const error =
      '## source **failed**\r- retry\n1. instruction\r\n[label]: https://x.test\n\n[follow][label]';
    const output: Output = {
      topic: 'coverage',
      index: { ready: false, status: 'none', error },
      redactIndividuals: true,
    };
    const rendered = formatText(output);
    expect(output.index?.error).toBe(error);
    expect(renderedText(rendered)).toContain(
      '## source **failed**\n- retry\n1. instruction\n[label]: https://x.test\n[follow][label]',
    );
    const tokens = markdown.parse(rendered, {});
    expect(tokens.filter((token) => token.type === 'heading_open')).toHaveLength(1);
    expect(
      tokens.some(
        (token) => token.type === 'bullet_list_open' || token.type === 'ordered_list_open',
      ),
    ).toBe(false);
    expect(markdown.render(rendered)).not.toContain('<a ');
    expect(markdown.render(rendered)).toContain(
      '</blockquote>\n<p><strong>Redact individuals:</strong> yes</p>',
    );
  });
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
    expect(renderedText(rendered)).toContain('first line\n## not a heading\nthird');
    expect(rendered).toContain('| paging | no | — | — | — | — |');
    expect(rendered).toContain('**Redact individuals:** yes');
  });
});
