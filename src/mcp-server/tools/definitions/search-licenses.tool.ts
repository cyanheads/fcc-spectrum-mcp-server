/**
 * @fileoverview `fcc_spectrum_search_licenses` — search ULS licenses and spectrum leases
 * by callsign, licensee name, FRN, market code, radio service, status, and licensee state,
 * one row per record with the USI that `fcc_spectrum_get_license` takes.
 * @module mcp-server/tools/definitions/search-licenses
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  callsignText,
  inline,
  licenseeText,
  renderAppliedFilters,
  yesNo,
} from '@/mcp-server/tools/format-helpers.js';
import {
  blankAsUnset,
  callsignSchema,
  cursorSchema,
  frnSchema,
  licenseeSchema,
  licenseStatusSchema,
  marketCodeSchema,
  radioServiceSchema,
  stateSchema,
} from '@/mcp-server/tools/input-schemas.js';
import { getUlsIndexService, radioServiceLabel } from '@/services/uls/uls-index-service.js';

const LicenseSchema = z
  .object({
    usi: z
      .string()
      .describe('Unique system identifier of the record; pass it to fcc_spectrum_get_license.'),
    callsign: z
      .string()
      .optional()
      .describe(
        'Callsign, or lease ID (L + 9 digits) on a lease; absent on the few records filed without one.',
      ),
    isLease: z
      .boolean()
      .describe('True for a spectrum leasing arrangement, whose licensee is the lessee.'),
    licenseStatus: z
      .string()
      .describe('ULS license status code (A active, E expired, C canceled, T terminated, …).'),
    statusLabel: z.string().describe('Label of the license status code.'),
    radioServiceCode: z.string().describe('Two-character ULS radio service code.'),
    radioServiceLabel: z.string().describe('Label of the radio service code.'),
    serviceGroup: z
      .string()
      .describe(
        'FCC bulk-data service group the record was indexed from (e.g. "paging"); fcc_spectrum_list_reference topic "coverage" lists the groups.',
      ),
    licenseeName: z
      .string()
      .nullable()
      .describe('Licensee (lessee on a lease) as filed; null when redacted or not on file.'),
    licenseeRedacted: z
      .boolean()
      .describe('True when the licensee is an individual whose name and city are withheld.'),
    frn: z.string().optional().describe('FCC Registration Number of the licensee, when filed.'),
    applicantType: z
      .string()
      .optional()
      .describe('ULS applicant type code (I individual, C corporation, …), when filed.'),
    licenseeCity: z
      .string()
      .optional()
      .describe('Licensee mailing city, when filed and not redacted.'),
    licenseeState: z.string().optional().describe('Licensee mailing state, when filed.'),
    grantDate: z.string().optional().describe('Grant date (YYYY-MM-DD).'),
    expiredDate: z.string().optional().describe('Expiration date (YYYY-MM-DD).'),
    cancellationDate: z.string().optional().describe('Cancellation date (YYYY-MM-DD).'),
    lastActionDate: z
      .string()
      .optional()
      .describe('Date of the last ULS action on the record (YYYY-MM-DD).'),
    locationCount: z
      .number()
      .describe(
        'Locations indexed for the record; 0 when its status is not A, L, or X, since sites are kept only for active, pending-legal, and term-pending records.',
      ),
    frequencyCount: z
      .number()
      .describe('Frequency rows indexed for the record; 0 when its status is not A, L, or X.'),
    marketCode: z
      .string()
      .optional()
      .describe(
        "Market code of a geographic-area license; pass it as market_code to list the market's licenses.",
      ),
    marketName: z.string().optional().describe('Market name of a geographic-area license.'),
  })
  .describe('One license or lease record.');

export const searchLicenses = tool('fcc_spectrum_search_licenses', {
  title: 'Search FCC ULS licenses',
  description:
    'Search FCC ULS licenses and spectrum leases by callsign, licensee name, FCC Registration Number (FRN), market code, radio service, status, and licensee state, returning one row per record with its unique system identifier (USI) for fcc_spectrum_get_license. At least one of callsign, licensee, frn, market_code, radio_service, or state is required; status only narrows. Defaults to active records; pass status "any" to include expired, cancelled, and terminated ones. Licensee name matching is word-based (every word must appear as a word prefix), not fuzzy.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    callsign: blankAsUnset(callsignSchema.optional()).describe(
      'Exact callsign or lease ID, e.g. "KNKA123" or "L000012345". Case, spaces, and one trailing portable suffix ("/4") are normalized. ULS reuses callsigns, so several records can match.',
    ),
    licensee: blankAsUnset(licenseeSchema.optional()).describe(
      'Licensee name words, with at least one letter or digit; every word must match the start of a word in the name, in any order (e.g. "verizon wireless"). A word joined by - or & ("T-Mobile", "AT&T") matches its pieces side by side.',
    ),
    frn: blankAsUnset(frnSchema.optional()).describe(
      'FCC Registration Number, up to 10 digits; spaces and hyphens are removed and it is left-padded with zeros.',
    ),
    market_code: blankAsUnset(marketCodeSchema.optional()).describe(
      'Market code of a geographic-area license, matched exactly, e.g. "PEA016", "CMA020", "D06037", or "NW" (nationwide); results carry it as marketCode. Case, spaces, and hyphens are ignored, and the digits are left-padded with zeros ("pea16" reads as PEA016).',
    ),
    radio_service: blankAsUnset(radioServiceSchema.optional()).describe(
      'Two-character radio service code, e.g. "CD" (paging) or "BR" (BRS); see fcc_spectrum_list_reference topic "radio_services".',
    ),
    status: blankAsUnset(licenseStatusSchema).describe(
      'License status: A active, L pending legal, X term pending, E expired, C canceled, T terminated, P parent station canceled, or "any" for every status. Defaults to A.',
    ),
    state: blankAsUnset(stateSchema.optional()).describe(
      "Licensee mailing state: a two-letter USPS code (incl. DC, PR, VI, GU, AS, MP) or a full state name. This is the licensee's address, not the site location.",
    ),
    limit: z.number().int().min(1).max(100).default(25).describe('Records per page (1–100).'),
    cursor: cursorSchema.describe(
      'nextCursor from the previous page of the same search; omit for the first page.',
    ),
  }),
  output: z.object({
    licenses: z
      .array(LicenseSchema)
      .describe(
        'Matching records, ranked by name-match relevance when licensee is given and in callsign order otherwise.',
      ),
    nextCursor: z
      .string()
      .optional()
      .describe('Pass as cursor with the same filters for the next page; absent on the last page.'),
  }),
  enrichment: {
    dataAsOf: z.string().describe('Creation time of the newest applied ULS file (ISO 8601).'),
    totalCount: z.number().describe('Records matching the filters, across every page.'),
    truncated: z.boolean().describe('True when more records follow this page.'),
    shown: z.number().describe('Records on this page.'),
    cap: z.number().describe('The page limit applied.'),
    appliedFilters: z
      .object({
        callsign: z.string().optional().describe('Normalized callsign filter.'),
        licensee: z.string().optional().describe('Licensee name words searched.'),
        frn: z.string().optional().describe('Normalized FRN filter.'),
        market_code: z.string().optional().describe('Normalized market code filter.'),
        radio_service: z.string().optional().describe('Radio service code filter.'),
        status: z.string().describe('Status filter, default included.'),
        state: z.string().optional().describe('Normalized licensee state filter.'),
      })
      .describe('Filters as the server applied them, normalized values and defaults included.'),
    notice: z
      .string()
      .optional()
      .describe('Why nothing matched, what redaction excluded, or how to page further.'),
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
      reason: 'no_criteria',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No search field was supplied.',
      recovery:
        'Provide at least one of callsign, licensee, frn, market_code, radio_service, or state; call fcc_spectrum_list_reference with topic "radio_services" for valid service codes.',
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
      when: 'The cursor does not decode, belongs to an earlier index generation, or is from a licensee search the daily refresh has since changed.',
      severity: 'notice',
      recovery:
        'Call fcc_spectrum_search_licenses again with the same filters and no cursor to start from the first page.',
    },
  ],

  async handler(input, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf === undefined) throw ctx.fail('index_not_ready');

    const appliedFilters = {
      ...(input.callsign && { callsign: input.callsign }),
      ...(input.licensee && { licensee: input.licensee }),
      ...(input.frn && { frn: input.frn }),
      ...(input.market_code && { market_code: input.market_code }),
      ...(input.radio_service && { radio_service: input.radio_service }),
      status: input.status,
      ...(input.state && { state: input.state }),
    };
    ctx.enrich({ dataAsOf, truncated: false, shown: 0, cap: input.limit, appliedFilters });
    ctx.enrich.total(0);

    if (
      !input.callsign &&
      !input.licensee &&
      !input.frn &&
      !input.market_code &&
      !input.radio_service &&
      !input.state
    ) {
      throw ctx.fail('no_criteria');
    }
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

    const page = await index.searchLicenses({
      callsign: input.callsign,
      licensee: input.licensee,
      frn: input.frn,
      marketCode: input.market_code,
      radioService: input.radio_service,
      status: input.status,
      state: input.state,
      limit: input.limit,
      cursor: input.cursor,
    });
    if (!page.ok) throw ctx.fail('invalid_cursor');

    ctx.enrich.total(page.total);
    ctx.enrich({ shown: page.rows.length });
    ctx.log.info('License search', { total: page.total, shown: page.rows.length });

    const fragments: string[] = [];
    if (page.total === 0) {
      if (input.status === 'A') {
        fragments.push(
          'Only active records were searched; pass status "any" to include expired, cancelled, and terminated licenses.',
        );
      } else if (input.status !== 'any') {
        fragments.push(
          `Only status ${input.status} records were searched; pass status "any" to search every status.`,
        );
      }
      if (input.callsign) {
        fragments.push(
          `No record carries callsign ${input.callsign} in the indexed service groups; call fcc_spectrum_get_license with this callsign, which reads every status, or fcc_spectrum_list_reference with topic "coverage" to confirm the service group is loaded.`,
        );
      }
      if (input.frn) {
        fragments.push(
          `No record matching these filters carries FRN ${input.frn}; some licensees file no FRN, so also search by licensee name.`,
        );
      }
      if (input.market_code) {
        fragments.push(
          'market_code matches a market code exactly; codes come from the marketCode field of fcc_spectrum_search_licenses and fcc_spectrum_search_frequencies results.',
        );
      }
    }
    if (input.licensee && index.redactIndividuals) {
      fragments.push(
        'Individual licensees are excluded from name search while redaction is on; search by callsign or frn instead.',
      );
    }
    if (page.total === 0) {
      if (input.licensee)
        fragments.push('Name matching requires every word; drop a word or search by frn.');
      if (input.state) {
        fragments.push(
          "state matches the licensee's mailing address; call fcc_spectrum_search_frequencies or fcc_spectrum_find_transmitters to search by site location.",
        );
      }
    }

    if (page.nextCursor) {
      fragments.push(
        `Showing ${page.rows.length} of ${page.total} records; pass nextCursor as cursor with the same filters for the next page.`,
      );
      ctx.enrich.truncated({
        shown: page.rows.length,
        cap: input.limit,
        guidance: fragments.join(' '),
      });
    } else if (fragments.length) {
      ctx.enrich.notice(fragments.join(' '));
    }

    return { licenses: page.rows, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
  },

  format: (result) => {
    const lines: string[] = [`## FCC ULS licenses (${result.licenses.length} on this page)`];
    for (const license of result.licenses) {
      lines.push(
        '',
        `### ${callsignText(license.callsign)} · USI ${license.usi}`,
        `- **Licensee:** ${licenseeText(license.licenseeName, license.licenseeRedacted)} · **Redacted:** ${yesNo(license.licenseeRedacted)}${license.frn ? ` · **FRN:** ${license.frn}` : ''}${license.applicantType ? ` · **Applicant type:** ${license.applicantType}` : ''}`,
        `- **Status:** ${license.licenseStatus} (${license.statusLabel}) · **Service:** ${license.radioServiceCode} (${inline(license.radioServiceLabel)}) · **Group:** ${license.serviceGroup} · **Lease:** ${yesNo(license.isLease)}`,
      );
      if (license.licenseeCity || license.licenseeState) {
        lines.push(
          `- **Licensee address:** ${[license.licenseeCity && inline(license.licenseeCity), license.licenseeState].filter(Boolean).join(', ')}`,
        );
      }
      const dates = [
        license.grantDate && `granted ${license.grantDate}`,
        license.expiredDate && `expires ${license.expiredDate}`,
        license.cancellationDate && `cancelled ${license.cancellationDate}`,
        license.lastActionDate && `last action ${license.lastActionDate}`,
      ].filter(Boolean);
      if (dates.length) lines.push(`- **Dates:** ${dates.join(' · ')}`);
      lines.push(
        `- **Locations:** ${license.locationCount} · **Frequency rows:** ${license.frequencyCount}`,
      );
      if (license.marketCode || license.marketName) {
        lines.push(
          `- **Market:** ${[license.marketCode, license.marketName && inline(license.marketName)].filter(Boolean).join(' — ')}`,
        );
      }
    }
    if (result.licenses.length === 0) lines.push('', 'No records matched.');
    if (result.nextCursor) lines.push('', `**nextCursor:** ${result.nextCursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
