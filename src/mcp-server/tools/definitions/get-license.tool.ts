/**
 * @fileoverview `fcc_spectrum_get_license` — one ULS license or spectrum lease in full, by
 * callsign or USI: licensee, status and dates, locations with antennas and frequency rows
 * (emission designators folded in), market blocks, and lease links in both directions.
 * @module mcp-server/tools/definitions/get-license
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { bandText, cell, inline, licenseeText, yesNo } from '@/mcp-server/tools/format-helpers.js';
import { blankAsUnset, callsignSchema, usiSchema } from '@/mcp-server/tools/input-schemas.js';
import { getUlsIndexService } from '@/services/uls/uls-index-service.js';

const FrequencySchema = z
  .object({
    frequencyMhz: z.number().describe('Assigned (center) frequency, MHz.'),
    upperMhz: z.number().optional().describe('Upper edge when the assignment is a range, MHz.'),
    bandwidthMhz: z
      .number()
      .optional()
      .describe('Widest necessary bandwidth parsed from the emission designators, MHz.'),
    stationClass: z
      .string()
      .optional()
      .describe('ULS class-of-station code, as filed (e.g. FB2, FXO).'),
    powerOutputW: z.number().optional().describe('Transmitter output power, watts.'),
    erpW: z.number().optional().describe('Effective radiated power, watts.'),
    eirpDbm: z.number().optional().describe('Effective isotropic radiated power, dBm.'),
    transmitterMake: z.string().optional().describe('Transmitter manufacturer, as filed.'),
    transmitterModel: z.string().optional().describe('Transmitter model, as filed.'),
    emissions: z
      .array(z.string().describe('One emission designator, e.g. "11K2F3E".'))
      .describe('Emission designators filed for this frequency row.'),
  })
  .describe(
    'One authorized frequency row, as filed (adaptive-modulation filings repeat a frequency per step).',
  );

const AntennaSchema = z
  .object({
    antennaNumber: z.number().describe('Antenna number within the location.'),
    antennaTypeCode: z
      .string()
      .optional()
      .describe('ULS antenna type code (T transmitting, R receiving, P passive, H hybrid).'),
    heightToTipM: z.number().optional().describe('Height to antenna tip above ground, meters.'),
    heightToCenterM: z
      .number()
      .optional()
      .describe('Height to center of radiation above ground, meters.'),
    haatM: z.number().optional().describe('Height above average terrain, meters.'),
    azimuthDeg: z.number().optional().describe('Azimuth of the main beam, degrees true.'),
    gainDbi: z.number().optional().describe('Antenna gain, dBi.'),
    beamwidthDeg: z.number().optional().describe('Beamwidth, degrees.'),
    polarization: z.string().optional().describe('Polarization code, as filed.'),
    make: z.string().optional().describe('Antenna manufacturer, as filed.'),
    model: z.string().optional().describe('Antenna model, as filed.'),
    frequencies: z
      .array(FrequencySchema)
      .describe('Frequency rows on this antenna, in filing order.'),
  })
  .describe('One antenna at a location.');

const LocationSchema = z
  .object({
    locationNumber: z.number().describe('Location number within the license.'),
    locationTypeCode: z
      .string()
      .optional()
      .describe('ULS location type code (F fixed, M mobile, …); absent when not filed.'),
    locationTypeLabel: z.string().optional().describe('Label of the location type code.'),
    locationClassCode: z.string().optional().describe('ULS location class code, as filed.'),
    latitude: z
      .number()
      .optional()
      .describe(
        'Latitude, decimal degrees (NAD83 as filed); absent when the filed coordinates fail validation.',
      ),
    longitude: z
      .number()
      .optional()
      .describe(
        'Longitude, decimal degrees (NAD83 as filed); absent when the filed coordinates fail validation.',
      ),
    coordinatesDms: z
      .string()
      .optional()
      .describe('Coordinates as filed, degrees-minutes-seconds text.'),
    groundElevationM: z
      .number()
      .optional()
      .describe('Ground elevation, meters above mean sea level.'),
    supportHeightM: z.number().optional().describe('Support structure height, meters.'),
    overallHeightM: z.number().optional().describe('Overall structure height, meters.'),
    structureType: z
      .string()
      .optional()
      .describe('Structure type code, as filed (e.g. TOWER, BTWR).'),
    asrNumber: z.string().optional().describe('FCC Antenna Structure Registration number.'),
    radiusKm: z.number().optional().describe('Radius of operation for an area location, km.'),
    address: z
      .string()
      .optional()
      .describe(
        "Site street address; omitted on an individual licensee's record while redaction is on.",
      ),
    city: z.string().optional().describe('Site city, as filed.'),
    county: z.string().optional().describe('Site county, as filed.'),
    state: z
      .string()
      .optional()
      .describe(
        'Site state: as filed, or derived from the coordinates when the filing leaves it blank.',
      ),
    stateFromCoordinates: z
      .boolean()
      .optional()
      .describe('True when state was derived from the coordinates rather than filed.'),
    name: z.string().optional().describe('Location name, as filed.'),
    antennas: z.array(AntennaSchema).describe('Antennas at this location.'),
  })
  .describe('One license location.');

const LicenseSchema = z
  .object({
    usi: z.string().describe('Unique system identifier.'),
    callsign: z.string().optional().describe('Callsign, or lease ID (L + 9 digits) on a lease.'),
    isLease: z.boolean().describe('True for a spectrum leasing arrangement.'),
    licenseStatus: z.string().describe('ULS license status code.'),
    statusLabel: z.string().describe('Label of the license status code.'),
    radioServiceCode: z.string().describe('Two-character ULS radio service code.'),
    radioServiceLabel: z.string().describe('Label of the radio service code.'),
    serviceGroup: z
      .string()
      .describe(
        'FCC bulk-data service group the record was indexed from (e.g. "paging"); fcc_spectrum_list_reference topic "coverage" lists the groups.',
      ),
    grantDate: z.string().optional().describe('Grant date (YYYY-MM-DD).'),
    effectiveDate: z.string().optional().describe('Effective date (YYYY-MM-DD).'),
    expiredDate: z.string().optional().describe('Expiration date (YYYY-MM-DD).'),
    cancellationDate: z.string().optional().describe('Cancellation date (YYYY-MM-DD).'),
    lastActionDate: z.string().optional().describe('Date of the last ULS action (YYYY-MM-DD).'),
    licensee: z
      .object({
        name: z
          .string()
          .nullable()
          .describe('Licensee or lessee name as filed; null when redacted or not on file.'),
        redacted: z
          .boolean()
          .describe('True when the licensee is an individual whose name and city are withheld.'),
        role: z
          .enum(['licensee', 'lessee'])
          .describe('lessee on a lease record, licensee otherwise.'),
        frn: z.string().optional().describe('FCC Registration Number, when filed.'),
        applicantType: z.string().optional().describe('ULS applicant type code, when filed.'),
        city: z.string().optional().describe('Mailing city, when filed and not redacted.'),
        state: z.string().optional().describe('Mailing state, when filed.'),
      })
      .describe('The licensee entity (the lessee on a lease).'),
    amateur: z
      .object({
        operatorClass: z.string().optional().describe('Amateur operator class code.'),
        operatorClassLabel: z.string().optional().describe('Label of the operator class code.'),
        trusteeCallsign: z
          .string()
          .optional()
          .describe('Trustee callsign of a club, military-recreation, or RACES license.'),
        trusteeName: z
          .string()
          .nullable()
          .optional()
          .describe('Trustee name; null when redaction withholds it.'),
        previousCallsign: z.string().optional().describe('Previous callsign of the station.'),
      })
      .optional()
      .describe('Amateur license details; present on amateur records.'),
    market: z
      .object({
        marketCode: z.string().describe('Market code (e.g. BTA028, CMA001).'),
        marketName: z
          .string()
          .optional()
          .describe('Market name as filed (cut at 30 characters by ULS).'),
        channelBlock: z.string().optional().describe('Channel block, as filed.'),
        blocks: z
          .array(
            z
              .object({
                lowMhz: z.number().describe('Lower edge, MHz.'),
                highMhz: z.number().describe('Upper edge, MHz.'),
              })
              .describe('One spectrum block.'),
          )
          .describe(
            'Spectrum blocks authorized in the market; kept only for status A, L, or X (active, pending legal, term pending), so empty otherwise.',
          ),
      })
      .optional()
      .describe('Geographic-area license market; present on market-based records.'),
    leasedFrom: z
      .array(
        z
          .object({
            callsign: z.string().optional().describe('Parent license callsign.'),
            usi: z.string().describe('Parent license USI; pass it as usi to read the parent.'),
          })
          .describe('One parent license.'),
      )
      .describe('Licenses this lease is carved from; empty unless the record is a lease.'),
    leases: z
      .array(
        z
          .object({
            callsign: z.string().optional().describe('Lease ID.'),
            usi: z.string().describe('Lease USI.'),
            licenseStatus: z.string().describe('Lease status code.'),
          })
          .describe('One lease.'),
      )
      .describe('Leases carved from this license, up to 25.'),
    leaseCount: z.number().describe('Total leases carved from this license.'),
  })
  .describe('The license or lease record.');

export const getLicense = tool('fcc_spectrum_get_license', {
  title: 'Get an FCC ULS license',
  description:
    "Fetch one FCC ULS license or spectrum lease in full by callsign or unique system identifier (USI): licensee (the lessee on a lease), status and key dates, every location with coordinates, elevation, structure height, and ASR number, each location's antennas, and each antenna's authorized frequencies with power, ERP/EIRP, station class, transmitter, and emission designators; geographic-area licenses list their market and spectrum blocks, and lease links are shown in both directions. Technical detail is kept for active, pending-legal, and term-pending records only. A callsign shared by several records returns the active one, else the most recent.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    callsign: blankAsUnset(callsignSchema.optional()).describe(
      'Callsign or lease ID, e.g. "KNKA123" or "L000012345". Case, spaces, and one trailing portable suffix ("/4") are normalized. Pass this or usi, not both.',
    ),
    usi: blankAsUnset(usiSchema.optional()).describe(
      'Unique system identifier, as digits: the usi field of fcc_spectrum_search_licenses, fcc_spectrum_find_transmitters, or fcc_spectrum_search_frequencies results. Pass this or callsign, not both.',
    ),
    max_frequencies: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe(
        'Most frequency rows to return across all locations (1–1000); large microwave and land-mobile licenses exceed the default.',
      ),
  }),
  output: z.object({
    found: z
      .boolean()
      .describe('True when a record matched; false returns guidance and candidates instead.'),
    guidance: z
      .string()
      .optional()
      .describe('Why nothing matched and where to look next; present when found is false.'),
    candidates: z
      .array(
        z
          .object({
            callsign: z.string().describe('Candidate callsign.'),
            usi: z.string().describe('Candidate USI.'),
            licenseStatus: z.string().describe('Candidate status code.'),
          })
          .describe('One callsign-prefix match.'),
      )
      .optional()
      .describe(
        'Up to 5 records whose callsign starts with the one requested; present when found is false.',
      ),
    license: LicenseSchema.optional().describe('The record; present when found is true.'),
    technicalRetained: z
      .boolean()
      .optional()
      .describe(
        'False when the status is not A, L, or X (active, pending legal, term pending): sites and frequencies are kept only for those, so locations is empty.',
      ),
    locations: z
      .array(LocationSchema)
      .optional()
      .describe('Locations with antennas and frequency rows; present when found is true.'),
    otherCallsignRecords: z
      .array(
        z
          .object({
            usi: z
              .string()
              .describe(
                'USI of another record under the same callsign; pass it as usi to read that record.',
              ),
            licenseStatus: z.string().describe('Its status code.'),
          })
          .describe('Another record sharing the callsign.'),
      )
      .optional()
      .describe(
        'Other records under the same callsign (ULS reuses callsigns); present when found is true.',
      ),
  }),
  enrichment: {
    dataAsOf: z.string().describe('Creation time of the newest applied ULS file (ISO 8601).'),
    truncated: z
      .boolean()
      .describe('True when frequency rows beyond max_frequencies were dropped.'),
    shown: z.number().describe('Frequency rows returned.'),
    cap: z.number().describe('The max_frequencies cap applied.'),
    notice: z
      .string()
      .optional()
      .describe('How many frequency rows were dropped and how to see them.'),
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
      reason: 'identifier_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of callsign and usi were supplied.',
      recovery:
        "Pass exactly one of callsign or usi; find a record's USI with fcc_spectrum_search_licenses.",
    },
  ],

  async handler(input, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf === undefined) throw ctx.fail('index_not_ready');
    ctx.enrich({ dataAsOf, truncated: false, shown: 0, cap: input.max_frequencies });

    if ((input.callsign === undefined) === (input.usi === undefined)) {
      throw ctx.fail(
        'identifier_required',
        input.callsign === undefined
          ? 'Neither callsign nor usi was given.'
          : 'Both callsign and usi were given; pass only one.',
      );
    }

    const result = await index.getLicense({
      callsign: input.callsign,
      usi: input.usi,
      maxFrequencies: input.max_frequencies,
    });
    if (!result.found) {
      return {
        found: false,
        guidance: input.callsign
          ? `No record with callsign ${input.callsign} in the indexed service groups. Try fcc_spectrum_search_licenses with licensee or frn, or call fcc_spectrum_list_reference with topic "coverage".`
          : `No record with USI ${input.usi}; USIs come from the usi field of fcc_spectrum_search_licenses, fcc_spectrum_find_transmitters, and fcc_spectrum_search_frequencies results.`,
        candidates: result.candidates,
      };
    }

    ctx.enrich({ shown: result.frequenciesShown });
    if (result.frequencyTotal > result.frequenciesShown) {
      ctx.enrich.truncated({
        shown: result.frequenciesShown,
        cap: input.max_frequencies,
        guidance: `Showing ${result.frequenciesShown} of ${result.frequencyTotal} frequency rows; rows beyond max_frequencies are dropped from the last locations first. ${input.max_frequencies < 1000 ? 'Raise max_frequencies (up to 1000) to see more.' : 'No call returns more than 1000 rows.'}`,
      });
    }
    return {
      found: true,
      license: result.license,
      technicalRetained: result.technicalRetained,
      locations: result.locations,
      otherCallsignRecords: result.otherCallsignRecords,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Found:** ${yesNo(result.found)}`);
    if (!result.found) lines.push('', '## No matching FCC ULS record');
    if (result.guidance) lines.push('', result.guidance);
    if (result.candidates) {
      lines.push(
        '',
        result.candidates.length
          ? '**Callsigns starting with the one requested:**'
          : 'No callsign-prefix candidates.',
      );
      for (const candidate of result.candidates) {
        lines.push(
          `- ${inline(candidate.callsign)} · USI ${candidate.usi} · status ${candidate.licenseStatus}`,
        );
      }
    }
    if (result.license) lines.push(...licenseLines(result.license));
    if (result.otherCallsignRecords?.length) {
      lines.push(
        `**Other records under this callsign:** ${result.otherCallsignRecords.map((other) => `USI ${other.usi} (${other.licenseStatus})`).join(', ')}`,
      );
    }
    if (result.technicalRetained !== undefined) {
      lines.push(`**Technical records retained:** ${yesNo(result.technicalRetained)}`);
      if (!result.technicalRetained) {
        lines.push(
          'Sites and frequencies are kept only for active (A), pending-legal (L), and term-pending (X) records, so this record lists none.',
        );
      }
    }
    if (result.locations) {
      lines.push('', `### Locations (${result.locations.length})`);
      for (const location of result.locations) lines.push(...locationLines(location));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** ` · **Label:** value` for a defined value, else nothing. */
function part(label: string, value: string | number | undefined): string {
  return value === undefined ? '' : ` · **${label}:** ${value}`;
}

function licenseLines(license: z.infer<typeof LicenseSchema>): string[] {
  const { licensee } = license;
  const lines = [
    `## ${license.callsign ? inline(license.callsign) : '(no callsign)'} · USI ${license.usi}`,
    `**Status:** ${license.licenseStatus} (${license.statusLabel}) · **Service:** ${license.radioServiceCode} (${inline(license.radioServiceLabel)}) · **Group:** ${license.serviceGroup} · **Lease:** ${yesNo(license.isLease)}`,
    `**${licensee.role === 'lessee' ? 'Lessee' : 'Licensee'}:** ${licenseeText(licensee.name, licensee.redacted)} · **Redacted:** ${yesNo(licensee.redacted)} · **Role:** ${licensee.role}${part('FRN', licensee.frn)}${part('Applicant type', licensee.applicantType)}${part('City', licensee.city && inline(licensee.city))}${part('State', licensee.state)}`,
  ];
  const dates = [
    license.grantDate && `granted ${license.grantDate}`,
    license.effectiveDate && `effective ${license.effectiveDate}`,
    license.expiredDate && `expires ${license.expiredDate}`,
    license.cancellationDate && `cancelled ${license.cancellationDate}`,
    license.lastActionDate && `last action ${license.lastActionDate}`,
  ].filter(Boolean);
  if (dates.length) lines.push(`**Dates:** ${dates.join(' · ')}`);

  const { amateur, market } = license;
  if (amateur) {
    const trustee =
      amateur.trusteeName === null
        ? 'redacted'
        : amateur.trusteeName && inline(amateur.trusteeName);
    lines.push(
      `**Amateur:**${part('Operator class', amateur.operatorClass && `${amateur.operatorClass}${amateur.operatorClassLabel ? ` (${amateur.operatorClassLabel})` : ''}`)}${part('Trustee callsign', amateur.trusteeCallsign)}${part('Trustee name', trustee)}${part('Previous callsign', amateur.previousCallsign)}`,
    );
  }
  if (market) {
    lines.push(
      `**Market:** ${market.marketCode}${market.marketName ? ` — ${inline(market.marketName)}` : ''}${part('Channel block', market.channelBlock && inline(market.channelBlock))}`,
    );
    if (market.blocks.length) {
      lines.push(
        `**Spectrum blocks:** ${market.blocks.map((block) => bandText(block.lowMhz, block.highMhz)).join(', ')}`,
      );
    }
  }
  if (license.leasedFrom.length) {
    lines.push(
      `**Leased from:** ${license.leasedFrom.map((parent) => `${parent.callsign ? inline(parent.callsign) : '(no callsign)'} (USI ${parent.usi})`).join(', ')}`,
    );
  }
  lines.push(
    `**Leases:** ${license.leaseCount}${license.leases.length < license.leaseCount ? ` (first ${license.leases.length} listed)` : ''}`,
  );
  for (const lease of license.leases) {
    lines.push(
      `- ${lease.callsign ? inline(lease.callsign) : '(no callsign)'} · USI ${lease.usi} · status ${lease.licenseStatus}`,
    );
  }
  return lines;
}

function locationLines(location: z.infer<typeof LocationSchema>): string[] {
  const coordinates =
    location.latitude !== undefined && location.longitude !== undefined
      ? `${location.latitude}, ${location.longitude}`
      : location.coordinatesDms
        ? 'not valid as filed'
        : 'not filed';
  const place = [location.address, location.city, location.county, location.state]
    .filter((value): value is string => Boolean(value))
    .map(inline)
    .join(', ');
  const lines = [
    '',
    `#### Location ${location.locationNumber}${location.name ? ` — ${inline(location.name)}` : ''}`,
    `**Type:** ${location.locationTypeCode ?? 'not filed'}${location.locationTypeLabel ? ` (${location.locationTypeLabel})` : ''}${part('Class', location.locationClassCode)} · **Coordinates:** ${coordinates}${part('Filed DMS', location.coordinatesDms && inline(location.coordinatesDms))}`,
  ];
  if (place || location.stateFromCoordinates !== undefined) {
    lines.push(
      `**Place:** ${place || 'not filed'}${location.stateFromCoordinates ? ' (state derived from coordinates)' : ''}${location.stateFromCoordinates === false ? ' (state as filed)' : ''}`,
    );
  }
  const structure = `${part('Ground elevation m', location.groundElevationM)}${part('Support height m', location.supportHeightM)}${part('Overall height m', location.overallHeightM)}${part('Structure', location.structureType && inline(location.structureType))}${part('ASR', location.asrNumber)}${part('Radius km', location.radiusKm)}`;
  if (structure) lines.push(structure.slice(3));

  for (const antenna of location.antennas) {
    lines.push(
      '',
      `**Antenna ${antenna.antennaNumber}**${part('Type', antenna.antennaTypeCode)}${part('Height to tip m', antenna.heightToTipM)}${part('Height to center m', antenna.heightToCenterM)}${part('HAAT m', antenna.haatM)}${part('Azimuth °', antenna.azimuthDeg)}${part('Gain dBi', antenna.gainDbi)}${part('Beamwidth °', antenna.beamwidthDeg)}${part('Polarization', antenna.polarization)}${part('Make', antenna.make && inline(antenna.make))}${part('Model', antenna.model && inline(antenna.model))}`,
    );
    if (!antenna.frequencies.length) continue;
    lines.push(
      '',
      '| Frequency MHz | Upper MHz | Bandwidth MHz | Class | Power W | ERP W | EIRP dBm | Transmitter | Emissions |',
      '|--------------:|----------:|--------------:|:------|--------:|------:|---------:|:------------|:----------|',
    );
    for (const frequency of antenna.frequencies) {
      const transmitter = [frequency.transmitterMake, frequency.transmitterModel]
        .filter((value): value is string => Boolean(value))
        .join(' ');
      lines.push(
        `| ${frequency.frequencyMhz} | ${frequency.upperMhz ?? '—'} | ${frequency.bandwidthMhz ?? '—'} | ${frequency.stationClass ? cell(frequency.stationClass) : '—'} | ${frequency.powerOutputW ?? '—'} | ${frequency.erpW ?? '—'} | ${frequency.eirpDbm ?? '—'} | ${transmitter ? cell(transmitter) : '—'} | ${frequency.emissions.length ? cell(frequency.emissions.join(', ')) : '—'} |`,
      );
    }
  }
  return lines;
}
