/**
 * @fileoverview `fcc-spectrum://license/{callsign}` — the `fcc_spectrum_get_license`
 * record for a callsign, as JSON. Tool coverage: `fcc_spectrum_get_license`.
 * @module mcp-server/resources/definitions/license
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { callsignSchema } from '@/mcp-server/tools/input-schemas.js';
import { getUlsIndexService } from '@/services/uls/uls-index-service.js';

/** Frequency rows returned, matching `fcc_spectrum_get_license`'s default `max_frequencies`. */
const MAX_FREQUENCIES = 100;

export const licenseResource = resource('fcc-spectrum://license/{callsign}', {
  name: 'fcc_spectrum_license',
  title: 'FCC ULS license by callsign',
  description:
    'One FCC ULS license or spectrum lease by callsign, as JSON: the record fcc_spectrum_get_license returns (licensee, status and dates, locations with antennas and up to 100 frequency rows, market blocks, lease links), plus dataAsOf and the frequency-row counts. A callsign shared by several records resolves to the active one, else the most recent.',
  mimeType: 'application/json',
  params: z.object({
    callsign: callsignSchema.describe(
      'Callsign or lease ID, e.g. KNKA123 or L000012345; case and one trailing portable suffix are normalized.',
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
    return {
      dataAsOf,
      license: result.license,
      technicalRetained: result.technicalRetained,
      locations: result.locations,
      otherCallsignRecords: result.otherCallsignRecords,
      frequenciesShown: result.frequenciesShown,
      frequencyTotal: result.frequencyTotal,
    };
  },
});
