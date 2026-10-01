/**
 * @fileoverview `fcc-spectrum://license/{callsign}` — the `fcc_spectrum_get_license`
 * record for a callsign, as JSON. Tool coverage: `fcc_spectrum_get_license`.
 * @module mcp-server/resources/definitions/license
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { callsignSchema } from '@/mcp-server/tools/input-schemas.js';
import { getUlsIndexService, LICENSE_PAGE } from '@/services/uls/uls-index-service.js';

/** Frequency rows returned, matching `fcc_spectrum_get_license`'s default `max_frequencies`. */
const MAX_FREQUENCIES = 100;

/**
 * Percent-decode a URI template variable, which reaches the handler as the URI carried it:
 * `{callsign}` matches no `/`, so a portable suffix arrives as `W1AW%2F4`. A malformed escape
 * is left as is for the callsign pattern to reject.
 */
function percentDecoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const licenseResource = resource('fcc-spectrum://license/{callsign}', {
  name: 'fcc_spectrum_license',
  title: 'FCC ULS license by callsign',
  description: `One FCC ULS license or spectrum lease by callsign, as JSON: the first page fcc_spectrum_get_license returns (licensee, status and dates, whole locations up to ${LICENSE_PAGE.sites} sites and ${LICENSE_PAGE.antennas} antennas with up to ${MAX_FREQUENCIES} frequency rows, market blocks, lease links with up to ${LICENSE_PAGE.leases} leases), plus dataAsOf, the location, site, and frequency-row counts, and a notice naming the fcc_spectrum_get_license call that reads whatever the page leaves out. A callsign shared by several records resolves to the active one, else the most recent.`,
  mimeType: 'application/json',
  params: z.object({
    callsign: z
      .preprocess(percentDecoded, callsignSchema)
      .describe(
        'Callsign or lease ID, e.g. KNKA123 or L000012345, percent-encoded; case and one trailing portable suffix, sent with its slash as %2F (W1AW%2F4), are normalized.',
      ),
  }),
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  errors: [
    {
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No completed index generation is published yet.',
      retryable: false,
      recovery:
        'The local ULS index has not been built yet; call fcc_spectrum_list_reference with topic "coverage" to see its build status. An operator must run the mirror:init script once before lookups work.',
    },
    {
      reason: 'license_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No indexed record carries the callsign.',
      recovery:
        'Search with fcc_spectrum_search_licenses by licensee or frn, or call fcc_spectrum_list_reference with topic "coverage" to confirm the service group is loaded.',
    },
  ],

  async handler(params, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf === undefined) throw ctx.fail('index_not_ready');

    const result = await index.getLicense({
      callsign: params.callsign,
      maxFrequencies: MAX_FREQUENCIES,
    });
    if (!result.found) {
      throw ctx.fail(
        'license_not_found',
        `No record with callsign ${params.callsign} in the indexed service groups.`,
        {
          callsign: params.callsign,
          // A callsign shared by several records is one candidate, not several.
          candidates: [...new Set(result.candidates.map((candidate) => candidate.callsign))],
        },
      );
    }
    const { license, locations } = result;
    const call = `call fcc_spectrum_get_license with usi "${license.usi}"`;
    const cut = result.frequencyCutAt;
    const notice = [
      result.nextLocationOffset !== undefined &&
        `Lists ${locations.length} of ${result.locationTotal} locations; ${call} and location_offset ${result.nextLocationOffset} for the rest.`,
      result.windowFrequencyTotal > result.frequenciesShown &&
        `Lists ${result.frequenciesShown} of ${result.windowFrequencyTotal} frequency rows at these locations; ${call} and a higher max_frequencies (up to 1000)${cut && cut.offset > 0 ? ` or location_offset ${cut.offset}` : ''} for the rest.`,
      result.nextLeaseOffset !== undefined &&
        `Lists ${license.leases.length} of ${license.leaseCount} leases; ${call} and lease_offset ${result.nextLeaseOffset} for the rest.`,
    ]
      .filter((fragment): fragment is string => Boolean(fragment))
      .join(' ');
    return {
      dataAsOf,
      license,
      technicalRetained: result.technicalRetained,
      locations,
      locationTotal: result.locationTotal,
      siteTotal: result.siteTotal,
      ...(result.nextLocationOffset !== undefined && {
        nextLocationOffset: result.nextLocationOffset,
      }),
      ...(result.nextLeaseOffset !== undefined && { nextLeaseOffset: result.nextLeaseOffset }),
      otherCallsignRecords: result.otherCallsignRecords,
      frequenciesShown: result.frequenciesShown,
      frequencyTotal: result.frequencyTotal,
      ...(notice && { notice }),
    };
  },
});
