/**
 * @fileoverview `fcc_spectrum_list_reference` — decode ULS vocabulary (radio services,
 * license statuses, location and antenna types, applicant types, amateur operator
 * classes) and report index coverage. Works before the index is built.
 * @module mcp-server/tools/definitions/list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { cell, yesNo } from '@/mcp-server/tools/format-helpers.js';
import { blankAsUnset, caseFolded } from '@/mcp-server/tools/input-schemas.js';
import {
  ANTENNA_TYPES,
  APPLICANT_TYPES,
  LICENSE_STATUSES,
  LOCATION_TYPES,
  OPERATOR_CLASSES,
  RADIO_SERVICES,
  toEntries,
} from '@/services/uls/codes.js';
import { getUlsIndexService } from '@/services/uls/uls-index-service.js';

const TOPICS = [
  'radio_services',
  'license_statuses',
  'location_types',
  'antenna_types',
  'applicant_types',
  'operator_classes',
  'coverage',
] as const;

type VocabularyTopic = Exclude<(typeof TOPICS)[number], 'coverage'>;

const VOCABULARY: Record<
  VocabularyTopic,
  { title: string; table: Readonly<Record<string, string>> }
> = {
  radio_services: { title: 'Radio services', table: RADIO_SERVICES },
  license_statuses: { title: 'License statuses', table: LICENSE_STATUSES },
  location_types: { title: 'Location types', table: LOCATION_TYPES },
  antenna_types: { title: 'Antenna types', table: ANTENNA_TYPES },
  applicant_types: { title: 'Applicant types', table: APPLICANT_TYPES },
  operator_classes: { title: 'Amateur operator classes', table: OPERATOR_CLASSES },
};

const EntrySchema = z
  .object({
    code: z.string().describe('The code as filed in ULS records.'),
    label: z
      .string()
      .describe(
        'FCC label for the code; equal to the code when the index holds a code the bundled table lacks.',
      ),
    group: z
      .string()
      .optional()
      .describe(
        'FCC bulk-data service group that carries this radio service code; radio_services only, absent for other topics and before the index is built.',
      ),
    indexedRecords: z
      .number()
      .optional()
      .describe(
        'Records in the index carrying this radio service code; radio_services only, absent for other topics and before the index is built.',
      ),
  })
  .describe('One decoded code.');

const IndexStateSchema = z
  .object({
    ready: z
      .boolean()
      .describe('True when a completed index generation is published and searches work.'),
    status: z
      .enum(['none', 'building', 'ready'])
      .describe(
        'none: never built; building: a build is in progress with no published generation yet; ready: searchable.',
      ),
    generation: z.string().optional().describe('File name of the published index generation.'),
    lastFullBuild: z
      .string()
      .optional()
      .describe('When the published generation finished its weekly rebuild (ISO 8601).'),
    lastDailyApplied: z
      .string()
      .optional()
      .describe(
        'Creation time of the newest daily file applied on top of the weekly snapshot (ISO 8601).',
      ),
    dataAsOf: z
      .string()
      .optional()
      .describe('Creation time of the newest applied ULS file (ISO 8601).'),
    error: z
      .string()
      .optional()
      .describe(
        'Why the published index cannot be served, or the message of the most recent failed build or refresh.',
      ),
  })
  .describe('State of the local index.');

const GroupSchema = z
  .object({
    group: z
      .string()
      .describe('FCC bulk-data service group name, as the FCC names its files (e.g. "LMpriv").'),
    indexed: z.boolean().describe('True when this group is loaded in the published index.'),
    records: z
      .number()
      .optional()
      .describe('License and lease records indexed from this group; absent when not indexed.'),
    sites: z
      .number()
      .optional()
      .describe(
        'Location records kept for this group (status A, L, or X licenses only); absent when not indexed.',
      ),
    frequencies: z
      .number()
      .optional()
      .describe(
        'Frequency records kept for this group (status A, L, or X licenses only); absent when not indexed.',
      ),
    snapshotCreated: z
      .string()
      .optional()
      .describe(
        "Creation time of the FCC's weekly snapshot this group was built from (ISO 8601); absent when not indexed.",
      ),
  })
  .describe('Coverage of one weekly service group.');

/** Lowercase, strip diacritics, and turn punctuation into spaces for token matching. */
const normalizeForMatch = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ');

export const listReference = tool('fcc_spectrum_list_reference', {
  title: 'List FCC ULS reference codes and coverage',
  description:
    'Decode FCC ULS codes used by the other tools — radio service codes, license statuses, location types, antenna types, applicant types, amateur operator classes — or report coverage: which service groups this index holds, record counts, and when each was last updated. Works before the index is built.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: caseFolded(z.enum(TOPICS)).describe(
      'What to list: a code vocabulary (radio_services, license_statuses, location_types, antenna_types, applicant_types, operator_classes) or coverage, the index build state and loaded service groups.',
    ),
    filter: blankAsUnset(z.string().max(200).optional()).describe(
      'Radio services only: keep entries whose code and label contain every word given, in any order (e.g. "700 public safety"). Case- and accent-insensitive.',
    ),
  }),
  output: z.object({
    topic: z.enum(TOPICS).describe('The topic answered.'),
    entries: z
      .array(EntrySchema)
      .optional()
      .describe('Decoded codes, in code order; present for every topic except coverage.'),
    index: IndexStateSchema.optional().describe('Index build state; present for coverage.'),
    groups: z
      .array(GroupSchema)
      .optional()
      .describe(
        'Every weekly service group this server can index, with whether it is loaded; present for coverage.',
      ),
    redactIndividuals: z
      .boolean()
      .optional()
      .describe(
        'True when individual licensees are redacted and excluded from name search; present for coverage.',
      ),
  }),
  enrichment: {
    dataAsOf: z
      .string()
      .optional()
      .describe(
        'Creation time of the newest applied ULS file (ISO 8601); absent before the index is built.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a filter matched nothing, was not applied, or the index is not built yet.',
      ),
  },

  async handler(input, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf) ctx.enrich({ dataAsOf });

    if (input.topic === 'coverage') {
      const coverage = await index.coverage();
      if (!coverage.index.ready) {
        ctx.enrich.notice(
          `The local ULS index has not been ${coverage.index.status === 'building' ? 'published yet (a build is running)' : 'built yet'}, so the search tools cannot answer; an operator must run the mirror:init script once. Configured service groups: ${index.services.join(', ')}.`,
        );
      }
      return { topic: input.topic, ...coverage };
    }

    const table = toEntries(VOCABULARY[input.topic].table);
    const indexed = input.topic === 'radio_services' ? await index.serviceCodes() : undefined;
    const all = indexed
      ? [
          ...table,
          ...[...indexed.keys()]
            .filter((code) => !Object.hasOwn(RADIO_SERVICES, code))
            .map((code) => ({ code, label: code })),
        ]
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((entry) => {
            const held = indexed.get(entry.code);
            return held ? { ...entry, group: held.group, indexedRecords: held.records } : entry;
          })
      : table;
    if (!input.filter) return { topic: input.topic, entries: all };
    if (input.topic !== 'radio_services') {
      ctx.enrich.notice(
        `filter applies to topic "radio_services" only; all ${all.length} ${VOCABULARY[input.topic].title.toLowerCase()} are listed.`,
      );
      return { topic: input.topic, entries: all };
    }

    const tokens = normalizeForMatch(input.filter).split(/\s+/).filter(Boolean);
    const entries = all.filter((entry) => {
      const haystack = normalizeForMatch(`${entry.code} ${entry.label}`);
      return tokens.every((token) => haystack.includes(token));
    });
    if (entries.length === 0) {
      ctx.enrich.notice(
        `No radio service code or label contains every word of ${JSON.stringify(input.filter)}; drop a word, or call without filter to list all ${all.length} codes.`,
      );
    }
    return { topic: input.topic, entries };
  },

  format: (result) => {
    const lines: string[] = [];
    const heading = result.topic === 'coverage' ? 'Index coverage' : VOCABULARY[result.topic].title;
    lines.push(`## ${heading}`, `**Topic:** ${result.topic}`);

    if (result.entries) {
      const withIndex = result.entries.some(
        (entry) => entry.group !== undefined || entry.indexedRecords !== undefined,
      );
      lines.push(
        '',
        `${result.entries.length} ${result.entries.length === 1 ? 'entry' : 'entries'}`,
        '',
        withIndex ? '| Code | Label | Group | Indexed records |' : '| Code | Label |',
        withIndex ? '|:-----|:------|:------|----------------:|' : '|:-----|:------|',
      );
      for (const entry of result.entries) {
        const base = `| ${cell(entry.code)} | ${cell(entry.label)} |`;
        lines.push(
          withIndex
            ? `${base} ${cell(entry.group ?? '—')} | ${entry.indexedRecords ?? '—'} |`
            : base,
        );
      }
    }

    if (result.index) {
      const index = result.index;
      lines.push('', `**Ready:** ${yesNo(index.ready)} · **Status:** ${index.status}`);
      if (index.generation) lines.push(`**Generation:** ${cell(index.generation)}`);
      if (index.lastFullBuild) lines.push(`**Last full build:** ${index.lastFullBuild}`);
      if (index.lastDailyApplied) lines.push(`**Last daily applied:** ${index.lastDailyApplied}`);
      if (index.dataAsOf) lines.push(`**Data as of:** ${index.dataAsOf}`);
      if (index.error) {
        lines.push('**Last error:**', ...index.error.split(/\r?\n/).map((line) => `> ${line}`));
      }
    }

    if (result.groups) {
      lines.push(
        '',
        '### Service groups',
        '',
        '| Group | Indexed | Records | Sites | Frequencies | Snapshot created |',
        '|:------|:--------|--------:|------:|------------:|:-----------------|',
      );
      for (const group of result.groups) {
        lines.push(
          `| ${cell(group.group)} | ${yesNo(group.indexed)} | ${group.records ?? '—'} | ${group.sites ?? '—'} | ${group.frequencies ?? '—'} | ${group.snapshotCreated ?? '—'} |`,
        );
      }
    }

    if (result.redactIndividuals !== undefined) {
      lines.push('', `**Redact individuals:** ${yesNo(result.redactIndividuals)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
