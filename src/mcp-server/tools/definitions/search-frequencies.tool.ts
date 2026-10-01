/**
 * @fileoverview `fcc_spectrum_search_frequencies` — ULS authorizations whose occupied band
 * overlaps a frequency or band: site assignments (one row per site and frequency) and
 * market-area spectrum blocks, filtered by state, radio service, licensee, and status.
 * @module mcp-server/tools/definitions/search-frequencies
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  bandText,
  cell,
  inline,
  joinNotice,
  licenseeText,
  orList,
  renderAppliedFilters,
  yesNo,
} from '@/mcp-server/tools/format-helpers.js';
import {
  blankAsUnset,
  caseFolded,
  cursorSchema,
  frequencySchema,
  licenseeSchema,
  liveStatusSchema,
  radioServiceSchema,
  stateSchema,
  unitSchema,
} from '@/mcp-server/tools/input-schemas.js';
import { PAL_BAND_MHZ } from '@/services/uls/codes.js';
import { resolveBand } from '@/services/uls/normalize.js';
import { getUlsIndexService, radioServiceLabel } from '@/services/uls/uls-index-service.js';

const KINDS = ['site', 'market', 'both'] as const;

const AssignmentSchema = z
  .object({
    kind: z
      .enum(['site', 'market'])
      .describe(
        'site: a frequency at a transmitter site; market: a spectrum block across a market area.',
      ),
    usi: z
      .string()
      .describe('Unique system identifier of the license; pass it to fcc_spectrum_get_license.'),
    callsign: z.string().optional().describe('Callsign, or lease ID on a lease.'),
    isLease: z.boolean().describe('True for a spectrum leasing arrangement.'),
    licenseStatus: z.string().describe('License status code (A, L, or X).'),
    radioServiceCode: z.string().describe('Two-character ULS radio service code.'),
    radioServiceLabel: z.string().describe('Label of the radio service code.'),
    licenseeName: z
      .string()
      .nullable()
      .describe('Licensee (lessee on a lease) as filed; null when redacted or not on file.'),
    licenseeRedacted: z
      .boolean()
      .describe('True when the licensee is an individual whose name is withheld.'),
    frequencyMhz: z
      .number()
      .describe('Assigned frequency (site) or block lower edge (market), MHz.'),
    upperMhz: z
      .number()
      .optional()
      .describe('Upper edge of a ranged site assignment or of a market block, MHz.'),
    bandwidthMhz: z
      .number()
      .optional()
      .describe(
        'Widest necessary bandwidth parsed from the emission designators, MHz (site rows); a designator 20% of the assigned frequency or wider is a filing error and is left out.',
      ),
    stationClasses: z
      .array(z.string().describe('One ULS class-of-station code.'))
      .optional()
      .describe('Distinct station classes filed for this frequency at the site (site rows).'),
    maxErpW: z
      .number()
      .optional()
      .describe('Highest effective radiated power filed, watts (site rows).'),
    emissions: z
      .array(z.string().describe('One emission designator.'))
      .optional()
      .describe('Distinct emission designators filed for this frequency (site rows).'),
    locationNumber: z
      .number()
      .optional()
      .describe('Location number within the license (site rows).'),
    latitude: z
      .number()
      .optional()
      .describe('Site latitude, decimal degrees (site rows with valid coordinates).'),
    longitude: z
      .number()
      .optional()
      .describe('Site longitude, decimal degrees (site rows with valid coordinates).'),
    county: z.string().optional().describe('Site county, as filed (site rows).'),
    state: z
      .string()
      .optional()
      .describe('Site state, as filed or derived from the coordinates (site rows).'),
    stateFromCoordinates: z
      .boolean()
      .optional()
      .describe('True when state was derived from the coordinates rather than filed (site rows).'),
    sitesSharingNumber: z
      .number()
      .optional()
      .describe(
        'Sites the license files under this location number, when more than one (site rows); ULS does not say which of them uses the frequency, so the row has no coordinates, county, or state. fcc_spectrum_get_license lists the sites.',
      ),
    marketCode: z.string().optional().describe('Market code (market rows).'),
    marketName: z
      .string()
      .optional()
      .describe('Market name as filed, cut at 30 characters by ULS (market rows).'),
    channelBlock: z.string().optional().describe('Channel block, as filed (market rows).'),
    partitionAreaIds: z
      .array(z.number().describe('One ULS partition area ID.'))
      .optional()
      .describe(
        'ULS partition areas this block is filed under (market rows); a partitioned license files one block per area, returned here as one row.',
      ),
  })
  .describe('One site assignment or market spectrum block.');

export const searchFrequencies = tool('fcc_spectrum_search_frequencies', {
  title: 'Search FCC ULS authorizations by frequency',
  description:
    "Find FCC ULS authorizations whose occupied band overlaps a frequency or band. Site assignments (land mobile, microwave, paging, cellular sites) return one row per site and frequency with the site's state and coordinates; market-area licenses and leases (PCS, AWS, 700 MHz, 3.45 and 3.7 GHz, and other auctioned blocks) return one row per spectrum block with its market code and name; 3.5 GHz Priority Access Licenses file no frequency, so list them with fcc_spectrum_search_licenses and radio_service PL. Filter by state, radio service, licensee, and live status (active by default). For transmitter sites near a coordinate, use fcc_spectrum_find_transmitters.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    frequency_low: frequencySchema.describe(
      "Frequency in unit; with frequency_high, the band's lower edge. Matches any authorization whose occupied band overlaps.",
    ),
    frequency_high: blankAsUnset(frequencySchema.optional()).describe(
      'Band upper edge in unit; omit to search a single frequency.',
    ),
    unit: blankAsUnset(unitSchema).describe('Unit of the frequencies: kHz, MHz (default), or GHz.'),
    kind: blankAsUnset(caseFolded(z.enum(KINDS).default('both'))).describe(
      'site: transmitter-site assignments only; market: market-area spectrum blocks only; both (default).',
    ),
    state: blankAsUnset(stateSchema.optional()).describe(
      'Two-letter USPS code or full state name. Sites match on their filed state, or the state derived from their coordinates; market blocks match on the state codes in the market name.',
    ),
    radio_service: blankAsUnset(radioServiceSchema.optional()).describe(
      'Two-character radio service code, e.g. "WU" (700 MHz upper band); see fcc_spectrum_list_reference topic "radio_services".',
    ),
    licensee: blankAsUnset(licenseeSchema.optional()).describe(
      'Licensee name words, with at least one letter or digit; every word must match the start of a word in the name, in any order. A word joined by - or & ("T-Mobile", "AT&T") matches its pieces side by side.',
    ),
    status: blankAsUnset(liveStatusSchema).describe(
      'A active (default), L pending legal, X term pending, or "any" for all three. Other statuses keep no frequency records.',
    ),
    limit: z.number().int().min(1).max(200).default(50).describe('Rows per page (1–200).'),
    cursor: cursorSchema.describe(
      'nextCursor from the previous page of the same search; omit for the first page.',
    ),
  }),
  output: z.object({
    assignments: z
      .array(AssignmentSchema)
      .describe('Matching site assignments and market blocks, frequency ascending.'),
    nextCursor: z
      .string()
      .optional()
      .describe('Pass as cursor with the same inputs for the next page; absent on the last page.'),
  }),
  enrichment: {
    dataAsOf: z.string().describe('Creation time of the newest applied ULS file (ISO 8601).'),
    totalCount: z.number().describe('Rows matching the filters, across every page.'),
    truncated: z.boolean().describe('True when more rows follow this page.'),
    shown: z.number().describe('Rows on this page.'),
    cap: z.number().describe('The page limit applied.'),
    appliedFilters: z
      .object({
        frequency_low_mhz: z.number().describe('Band lower edge, converted to MHz.'),
        frequency_high_mhz: z
          .number()
          .describe(
            'Band upper edge, converted to MHz (equal to the lower edge for one frequency).',
          ),
        kind: z.string().describe('Kinds searched.'),
        state: z.string().optional().describe('Normalized state filter.'),
        radio_service: z.string().optional().describe('Radio service code filter.'),
        licensee: z.string().optional().describe('Licensee name words searched.'),
        status: z.string().describe('Status filter, default included.'),
      })
      .describe('Filters as the server applied them, normalized values and defaults included.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Why nothing matched, what the state and redaction rules skipped, or how to page further.',
      ),
  },
  enrichmentTrailer: { appliedFilters: { render: renderAppliedFilters } },
  errors: [
    {
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No completed index generation is published yet.',
      retryable: false,
      recovery:
        'The local ULS index has not been built yet; call fcc_spectrum_list_reference with topic "coverage" to see its build status. An operator must run the mirror:init script once before searches work.',
    },
    {
      reason: 'invalid_frequency_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'frequency_high is below frequency_low, or the band exceeds 300 GHz.',
      recovery:
        'Keep frequency_high at or above frequency_low in the same unit and both at or below 300 GHz; omit frequency_high to match one frequency.',
    },
    {
      reason: 'unknown_radio_service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The radio service code is neither in the FCC code table nor held by the index.',
      recovery:
        'Call fcc_spectrum_list_reference with topic "radio_services" to find the two-letter code for this service.',
    },
    {
      reason: 'service_not_indexed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The radio service code is valid but no indexed service group carries it.',
      recovery:
        'This deployment does not index that service; call fcc_spectrum_list_reference with topic "coverage" to see which service groups are loaded.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor does not decode or belongs to an earlier index generation.',
      severity: 'notice',
      recovery:
        'Call fcc_spectrum_search_frequencies again with the same inputs and no cursor to start from the first page.',
    },
  ],

  async handler(input, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf === undefined) throw ctx.fail('index_not_ready');

    const band = resolveBand(input.frequency_low, input.frequency_high, input.unit);
    if (!band?.ok) {
      throw ctx.fail(
        'invalid_frequency_range',
        band?.reason === 'high_below_low'
          ? `frequency_high (${input.frequency_high} ${input.unit}) is below frequency_low (${input.frequency_low} ${input.unit}).`
          : 'The band reaches above 300 GHz (300000 MHz), the top of the radio spectrum ULS licenses.',
      );
    }
    const appliedFilters = {
      frequency_low_mhz: band.lowMhz,
      frequency_high_mhz: band.highMhz,
      kind: input.kind,
      ...(input.state && { state: input.state }),
      ...(input.radio_service && { radio_service: input.radio_service }),
      ...(input.licensee && { licensee: input.licensee }),
      status: input.status,
    };
    ctx.enrich({ dataAsOf, truncated: false, shown: 0, cap: input.limit, appliedFilters });
    ctx.enrich.total(0);

    if (input.radio_service) {
      const code = input.radio_service;
      const known = await index.classifyRadioService(code);
      if (known === 'unknown') {
        throw ctx.fail('unknown_radio_service', `"${code}" is not a ULS radio service code.`, {
          radioService: code,
        });
      }
      if (known === 'not_indexed') {
        throw ctx.fail(
          'service_not_indexed',
          `Radio service ${code} (${radioServiceLabel(code)}) is not in any service group this deployment indexes (${index.services.join(', ')}).`,
          { radioService: code },
        );
      }
    }

    const page = await index.searchFrequencies({
      band: { lowMhz: band.lowMhz, highMhz: band.highMhz },
      kind: input.kind,
      state: input.state,
      radioService: input.radio_service,
      licensee: input.licensee,
      status: input.status,
      limit: input.limit,
      cursor: input.cursor,
    });
    if (!page.ok) throw ctx.fail('invalid_cursor');

    ctx.enrich.total(page.total);
    ctx.enrich({ shown: page.rows.length });
    ctx.log.info('Frequency search', { total: page.total, shown: page.rows.length });

    const fragments: string[] = [];
    if (page.total === 0) {
      if (input.status === 'A') {
        fragments.push(
          'Only active records were searched; pass status "any" to include pending-legal and term-pending ones.',
        );
      }
      const widen = orList([
        input.state && 'drop state',
        input.radio_service && 'drop radio_service',
        input.licensee && 'drop licensee',
        'widen the band',
        input.kind !== 'both' && 'pass kind "both"',
      ]);
      fragments.push(
        `No authorization overlaps ${bandText(band.lowMhz, band.highMhz)}${input.state ? ` in ${input.state}` : ''} under these filters; ${widen}.`,
      );
    }
    if (input.state && input.kind !== 'site') {
      fragments.push(
        'State filtering on market licenses reads the state codes in the market name; markets with no state in their name are skipped.',
      );
    }
    if (input.licensee && index.redactIndividuals) {
      fragments.push(
        'Individual licensees are excluded from name search while redaction is on; search without licensee to see them.',
      );
    }
    if (
      band.lowMhz <= PAL_BAND_MHZ.high &&
      band.highMhz >= PAL_BAND_MHZ.low &&
      input.kind !== 'site' &&
      (!input.radio_service || input.radio_service === 'PL')
    ) {
      fragments.push(
        `ULS files Priority Access Licenses (radio service PL, ${PAL_BAND_MHZ.low}–${PAL_BAND_MHZ.high} MHz) as a 10 MHz channel width with no frequency, so frequency search does not match them; list them with fcc_spectrum_search_licenses and radio_service "PL".`,
      );
    }
    if (page.nextCursor) {
      fragments.push(
        `Showing ${page.rows.length} of ${page.total} rows; pass nextCursor as cursor with the same inputs for the next page.`,
      );
      ctx.enrich.truncated({
        shown: page.rows.length,
        cap: input.limit,
        guidance: fragments.join(' '),
      });
    } else {
      const notice = joinNotice(fragments);
      if (notice) ctx.enrich.notice(notice);
    }

    return { assignments: page.rows, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
  },

  format: (result) => {
    const lines: string[] = [
      `## Frequency authorizations (${result.assignments.length} on this page)`,
    ];
    for (const row of result.assignments) {
      lines.push(
        '',
        `### ${bandText(row.frequencyMhz, row.upperMhz)} · ${row.kind} · ${row.callsign ? inline(row.callsign) : '(no callsign)'} · USI ${row.usi}`,
        `- **Licensee:** ${licenseeText(row.licenseeName, row.licenseeRedacted)} · **Redacted:** ${yesNo(row.licenseeRedacted)} · **Lease:** ${yesNo(row.isLease)}`,
        `- **Status:** ${row.licenseStatus} · **Service:** ${row.radioServiceCode} (${inline(row.radioServiceLabel)})`,
      );
      if (
        row.locationNumber !== undefined ||
        row.latitude !== undefined ||
        row.county ||
        row.state
      ) {
        const place = [row.county && inline(row.county), row.state].filter(Boolean).join(', ');
        lines.push(
          `- **Site:** location ${row.locationNumber ?? '—'}${row.latitude !== undefined && row.longitude !== undefined ? ` · ${row.latitude}, ${row.longitude}` : ''}${place ? ` · ${place}` : ''}${row.stateFromCoordinates ? ' (state derived from coordinates)' : ''}${row.stateFromCoordinates === false ? ' (state as filed)' : ''}${row.sitesSharingNumber !== undefined ? ` · ${row.sitesSharingNumber} sites share this location number; ULS does not say which uses this frequency` : ''}`,
        );
      }
      const technical = [
        row.bandwidthMhz !== undefined && `**Bandwidth:** ${row.bandwidthMhz} MHz`,
        row.stationClasses?.length && `**Station classes:** ${cell(row.stationClasses.join(', '))}`,
        row.maxErpW !== undefined && `**Max ERP:** ${row.maxErpW} W`,
        row.emissions?.length && `**Emissions:** ${cell(row.emissions.join(', '))}`,
      ].filter(Boolean);
      if (technical.length) lines.push(`- ${technical.join(' · ')}`);
      if (row.marketCode || row.marketName || row.channelBlock) {
        lines.push(
          `- **Market:** ${[row.marketCode, row.marketName && inline(row.marketName)].filter(Boolean).join(' — ')}${row.channelBlock ? ` · **Block:** ${inline(row.channelBlock)}` : ''}${row.partitionAreaIds?.length ? ` · **Partition areas:** ${row.partitionAreaIds.join(', ')}` : ''}`,
        );
      }
    }
    if (result.assignments.length === 0) lines.push('', 'No authorizations matched.');
    if (result.nextCursor) lines.push('', `**nextCursor:** ${result.nextCursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
