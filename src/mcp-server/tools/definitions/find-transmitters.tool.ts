/**
 * @fileoverview `fcc_spectrum_find_transmitters` — licensed transmitter sites within a
 * radius of a coordinate, nearest first, each with the frequencies authorized there.
 * @module mcp-server/tools/definitions/find-transmitters
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
  cursorSchema,
  frequencySchema,
  latitudeSchema,
  liveStatusSchema,
  longitudeSchema,
  radioServiceSchema,
  unitSchema,
} from '@/mcp-server/tools/input-schemas.js';
import { resolveBand } from '@/services/uls/normalize.js';
import { getUlsIndexService, radioServiceLabel } from '@/services/uls/uls-index-service.js';

const SiteFrequencySchema = z
  .object({
    frequencyMhz: z.number().describe('Assigned (center) frequency, MHz.'),
    upperMhz: z.number().optional().describe('Upper edge when the assignment is a range, MHz.'),
    bandwidthMhz: z
      .number()
      .optional()
      .describe('Widest necessary bandwidth parsed from the emission designators, MHz.'),
    stationClasses: z
      .array(z.string().describe('One ULS class-of-station code, e.g. "FB2".'))
      .describe(
        'Distinct station classes filed for this frequency across antennas and modulation steps.',
      ),
    maxErpW: z.number().optional().describe('Highest effective radiated power filed, watts.'),
    maxEirpDbm: z
      .number()
      .optional()
      .describe('Highest effective isotropic radiated power filed, dBm.'),
    emissions: z
      .array(z.string().describe('One emission designator, e.g. "11K2F3E".'))
      .describe('Distinct emission designators filed for this frequency.'),
  })
  .describe(
    'One frequency authorized at the site, collapsed across antennas and modulation steps.',
  );

const SiteSchema = z
  .object({
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
    locationNumber: z.number().describe('Location number within the license.'),
    locationTypeCode: z
      .string()
      .optional()
      .describe('ULS location type code; absent when not filed.'),
    distanceKm: z.number().describe('Great-circle distance from the search center, km.'),
    latitude: z.number().describe('Site latitude, decimal degrees (NAD83 as filed).'),
    longitude: z.number().describe('Site longitude, decimal degrees (NAD83 as filed).'),
    groundElevationM: z
      .number()
      .optional()
      .describe('Ground elevation, meters above mean sea level.'),
    overallHeightM: z.number().optional().describe('Overall structure height, meters.'),
    asrNumber: z.string().optional().describe('FCC Antenna Structure Registration number.'),
    county: z.string().optional().describe('Site county, as filed.'),
    state: z.string().optional().describe('Site state: as filed, or derived from the coordinates.'),
    stateFromCoordinates: z
      .boolean()
      .optional()
      .describe('True when state was derived from the coordinates rather than filed.'),
    frequencyCount: z
      .number()
      .describe('Frequencies at the site (only those overlapping the band when one is given).'),
    frequenciesShown: z.number().describe('Frequencies listed, after max_frequencies_per_site.'),
    frequencies: z.array(SiteFrequencySchema).describe('Frequencies at the site, ascending.'),
  })
  .describe('One transmitter site.');

export const findTransmitters = tool('fcc_spectrum_find_transmitters', {
  title: 'Find FCC-licensed transmitters near a point',
  description:
    'Find FCC-licensed transmitter sites within a radius of a coordinate, nearest first, each with its callsign, licensee, distance, coordinates, ground elevation, structure height, and the frequencies authorized there. Filter by frequency or band, radio service, and live status (active by default). Coordinates are decimal degrees or DMS strings; mobile-only and area-wide authorizations without a fixed coordinate are not returned, and market-area licenses without site records are found with fcc_spectrum_search_frequencies.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    latitude: latitudeSchema.describe(
      'Search center latitude: decimal degrees (47.6205, "47.6205") or a DMS string with hemisphere ("47-37-13.8 N", "47°37\'13.8"N").',
    ),
    longitude: longitudeSchema.describe(
      'Search center longitude: decimal degrees (-122.3493) or a DMS string with hemisphere ("122-20-57.5 W").',
    ),
    radius_km: z.number().min(0.1).max(100).default(5).describe('Search radius in km (0.1–100).'),
    frequency_low: blankAsUnset(frequencySchema.optional()).describe(
      "Only sites authorized on this frequency, in unit; with frequency_high, the band's lower edge. Matches any assignment whose occupied band overlaps.",
    ),
    frequency_high: blankAsUnset(frequencySchema.optional()).describe(
      'Band upper edge in unit; requires frequency_low.',
    ),
    unit: blankAsUnset(unitSchema).describe('Unit of the frequencies: kHz, MHz (default), or GHz.'),
    radio_service: blankAsUnset(radioServiceSchema.optional()).describe(
      'Two-character radio service code, e.g. "IG" (industrial/business pool); see fcc_spectrum_list_reference topic "radio_services".',
    ),
    status: blankAsUnset(liveStatusSchema).describe(
      'A active (default), L pending legal, X term pending, or "any" for all three. Other statuses keep no site records.',
    ),
    limit: z.number().int().min(1).max(100).default(25).describe('Sites per page (1–100).'),
    max_frequencies_per_site: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Most frequencies listed per site (1–50); frequencyCount carries the full count.'),
    cursor: cursorSchema.describe(
      'nextCursor from the previous page of the same search; omit for the first page.',
    ),
  }),
  output: z.object({
    sites: z.array(SiteSchema).describe('Transmitter sites, nearest first.'),
    nextCursor: z
      .string()
      .optional()
      .describe('Pass as cursor with the same inputs for the next page; absent on the last page.'),
  }),
  enrichment: {
    dataAsOf: z.string().describe('Creation time of the newest applied ULS file (ISO 8601).'),
    totalCount: z
      .number()
      .describe('Sites within the radius matching the filters, across every page.'),
    truncated: z.boolean().describe('True when more sites follow this page.'),
    shown: z.number().describe('Sites on this page.'),
    cap: z.number().describe('The page limit applied.'),
    searchCenter: z
      .object({
        latitude: z.number().describe('Center latitude, decimal degrees.'),
        longitude: z.number().describe('Center longitude, decimal degrees.'),
        radiusKm: z.number().describe('Search radius, km.'),
      })
      .describe('The search circle as the server applied it (DMS input converted).'),
    appliedFilters: z
      .object({
        frequency_low_mhz: z.number().optional().describe('Band lower edge, converted to MHz.'),
        frequency_high_mhz: z.number().optional().describe('Band upper edge, converted to MHz.'),
        radio_service: z.string().optional().describe('Radio service code filter.'),
        status: z.string().describe('Status filter, default included.'),
        max_frequencies_per_site: z.number().describe('Per-site frequency cap applied.'),
      })
      .describe('Filters as the server applied them, normalized values and defaults included.'),
    notice: z
      .string()
      .optional()
      .describe('Why nothing matched and how to widen the search, or how to page further.'),
  },
  enrichmentTrailer: {
    searchCenter: {
      render: (center: { latitude: number; longitude: number; radiusKm: number }) =>
        `**Search center:** ${center.latitude}, ${center.longitude} · radius ${center.radiusKm} km`,
    },
    appliedFilters: { render: renderAppliedFilters },
  },
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
      when: 'frequency_high is below frequency_low, is given without frequency_low, or the band exceeds 300 GHz.',
      recovery:
        'Pass frequency_low whenever frequency_high is set, keep frequency_high at or above frequency_low in the same unit, and keep both at or below 300 GHz; omit frequency_high to match one frequency.',
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
      recovery:
        'Call fcc_spectrum_find_transmitters again with the same inputs and no cursor to start from the first page.',
    },
  ],

  async handler(input, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf === undefined) throw ctx.fail('index_not_ready');

    const band = resolveBand(input.frequency_low, input.frequency_high, input.unit);
    const appliedFilters = {
      ...(band?.ok && {
        frequency_low_mhz: band.lowMhz,
        frequency_high_mhz: band.highMhz,
      }),
      ...(input.radio_service && { radio_service: input.radio_service }),
      status: input.status,
      max_frequencies_per_site: input.max_frequencies_per_site,
    };
    ctx.enrich({
      dataAsOf,
      truncated: false,
      shown: 0,
      cap: input.limit,
      searchCenter: {
        latitude: input.latitude,
        longitude: input.longitude,
        radiusKm: input.radius_km,
      },
      appliedFilters,
    });
    ctx.enrich.total(0);

    if (band && !band.ok) {
      throw ctx.fail(
        'invalid_frequency_range',
        band.reason === 'above_max'
          ? 'The band reaches above 300 GHz (300000 MHz), the top of the radio spectrum ULS licenses.'
          : band.reason === 'high_without_low'
            ? 'frequency_high was given without frequency_low.'
            : `frequency_high (${input.frequency_high} ${input.unit}) is below frequency_low (${input.frequency_low} ${input.unit}).`,
      );
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

    const page = await index.findTransmitters({
      latitude: input.latitude,
      longitude: input.longitude,
      radiusKm: input.radius_km,
      band: band && { lowMhz: band.lowMhz, highMhz: band.highMhz },
      radioService: input.radio_service,
      status: input.status,
      limit: input.limit,
      maxFrequenciesPerSite: input.max_frequencies_per_site,
      cursor: input.cursor,
    });
    if (!page.ok) throw ctx.fail('invalid_cursor');

    ctx.enrich.total(page.total);
    ctx.enrich({ shown: page.rows.length });
    ctx.log.info('Transmitter search', { total: page.total, shown: page.rows.length });

    const fragments: string[] = [];
    if (page.total === 0) {
      const widen = orList([
        input.radius_km < 100 && 'raise radius_km (max 100)',
        band && 'widen the band with frequency_high',
        input.radio_service && 'drop radio_service',
        input.status !== 'any' && 'pass status "any"',
        band && 'call fcc_spectrum_search_frequencies to search by state',
      ]);
      fragments.push(
        `No transmitter site within ${input.radius_km} km ${band ? `is authorized on ${bandText(band.lowMhz, band.highMhz)} under` : 'matches'} these filters${widen ? `; ${widen}` : ''}.`,
        'Market-area licenses (PCS, AWS, 700 MHz, 3.5 GHz) usually have no site records; call fcc_spectrum_search_frequencies with kind "market".',
      );
    }
    if (page.nextCursor) {
      fragments.push(
        `Showing ${page.rows.length} of ${page.total} sites; pass nextCursor as cursor with the same inputs for the next page.`,
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

    return { sites: page.rows, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
  },

  format: (result) => {
    const lines: string[] = [`## Transmitter sites (${result.sites.length} on this page)`];
    for (const site of result.sites) {
      const place = [site.county && inline(site.county), site.state].filter(Boolean).join(', ');
      lines.push(
        '',
        `### ${site.distanceKm} km · ${site.callsign ? inline(site.callsign) : '(no callsign)'} · USI ${site.usi} · location ${site.locationNumber}`,
        `- **Licensee:** ${licenseeText(site.licenseeName, site.licenseeRedacted)} · **Redacted:** ${yesNo(site.licenseeRedacted)} · **Lease:** ${yesNo(site.isLease)}`,
        `- **Status:** ${site.licenseStatus} · **Service:** ${site.radioServiceCode} (${inline(site.radioServiceLabel)})${site.locationTypeCode ? ` · **Location type:** ${site.locationTypeCode}` : ''}`,
        `- **Coordinates:** ${site.latitude}, ${site.longitude}${site.groundElevationM !== undefined ? ` · **Ground elevation:** ${site.groundElevationM} m` : ''}${site.overallHeightM !== undefined ? ` · **Overall height:** ${site.overallHeightM} m` : ''}${site.asrNumber ? ` · **ASR:** ${site.asrNumber}` : ''}`,
      );
      if (place) {
        lines.push(
          `- **Place:** ${place}${site.stateFromCoordinates ? ' (state derived from coordinates)' : ''}${site.stateFromCoordinates === false ? ' (state as filed)' : ''}`,
        );
      }
      lines.push(`- **Frequencies:** ${site.frequenciesShown} of ${site.frequencyCount} listed`);
      if (!site.frequencies.length) continue;
      lines.push(
        '',
        '| Frequency MHz | Upper MHz | Bandwidth MHz | Station classes | Max ERP W | Max EIRP dBm | Emissions |',
        '|--------------:|----------:|--------------:|:----------------|----------:|-------------:|:----------|',
      );
      for (const frequency of site.frequencies) {
        lines.push(
          `| ${frequency.frequencyMhz} | ${frequency.upperMhz ?? '—'} | ${frequency.bandwidthMhz ?? '—'} | ${frequency.stationClasses.length ? cell(frequency.stationClasses.join(', ')) : '—'} | ${frequency.maxErpW ?? '—'} | ${frequency.maxEirpDbm ?? '—'} | ${frequency.emissions.length ? cell(frequency.emissions.join(', ')) : '—'} |`,
        );
      }
    }
    if (result.sites.length === 0) lines.push('', 'No sites matched.');
    if (result.nextCursor) lines.push('', `**nextCursor:** ${result.nextCursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
