/**
 * @fileoverview Read-model types returned by `UlsIndexService` — shaped as the tools'
 * outputs (camelCase, USIs as strings, absent values omitted), so handlers pass them
 * through. Licensee fields already carry the redaction chokepoint's decisions.
 * @module services/uls/types
 */

import type { LiveStatus } from './schema.js';

/** Status filter for tools that read every status. */
export type LicenseStatusFilter = 'A' | 'C' | 'E' | 'L' | 'P' | 'T' | 'X' | 'any';

/** Status filter for the site and frequency tools; `any` means the three live statuses. */
export type LiveStatusFilter = LiveStatus | 'any';

/** A query band in MHz (`lowMhz === highMhz` for a single frequency). */
export interface Band {
  highMhz: number;
  lowMhz: number;
}

/** How a radio service code relates to the index. */
export type RadioServiceClass = 'indexed' | 'not_indexed' | 'unknown';

/** One page of keyset-paginated results. */
export interface Page<T> {
  /** Opaque cursor for the next page; absent on the last page. */
  nextCursor?: string;
  rows: T[];
  /** Matches before the limit. */
  total: number;
}

/** A page, or the reason the cursor could not be used. */
export type PageResult<T> = ({ ok: true } & Page<T>) | { ok: false; reason: 'invalid_cursor' };

/** Licensee name fields after redaction. */
export interface LicenseeFields {
  licenseeName: string | null;
  /** True when the name (and city) were withheld because the licensee is an individual. */
  licenseeRedacted: boolean;
}

/** One `search_licenses` row. */
export interface LicenseSummary extends LicenseeFields {
  applicantType?: string;
  /** Absent on the few records ULS files without one (old expired licenses). */
  callsign?: string;
  cancellationDate?: string;
  expiredDate?: string;
  frequencyCount: number;
  frn?: string;
  grantDate?: string;
  isLease: boolean;
  lastActionDate?: string;
  licenseeCity?: string;
  licenseeState?: string;
  licenseStatus: string;
  locationCount: number;
  marketCode?: string;
  marketName?: string;
  radioServiceCode: string;
  radioServiceLabel: string;
  serviceGroup: string;
  statusLabel: string;
  usi: string;
}

/** `searchLicenses` parameters (already normalized by the tool schema). */
export interface SearchLicensesParams {
  callsign?: string | undefined;
  cursor?: string | undefined;
  frn?: string | undefined;
  licensee?: string | undefined;
  limit: number;
  radioService?: string | undefined;
  state?: string | undefined;
  status: LicenseStatusFilter;
}

/** An authorized frequency row on a license's antenna, as filed. */
export interface LicenseFrequency {
  bandwidthMhz?: number;
  eirpDbm?: number;
  emissions: string[];
  erpW?: number;
  frequencyMhz: number;
  powerOutputW?: number;
  stationClass?: string;
  transmitterMake?: string;
  transmitterModel?: string;
  upperMhz?: number;
}

/** An antenna at a license location, with its frequency rows. */
export interface LicenseAntenna {
  antennaNumber: number;
  antennaTypeCode?: string;
  azimuthDeg?: number;
  beamwidthDeg?: number;
  frequencies: LicenseFrequency[];
  gainDbi?: number;
  haatM?: number;
  heightToCenterM?: number;
  heightToTipM?: number;
  make?: string;
  model?: string;
  polarization?: string;
}

/** A license location with its antennas. */
export interface LicenseLocation {
  /** Street address; omitted on an individual's record while redaction is on. */
  address?: string;
  antennas: LicenseAntenna[];
  asrNumber?: string;
  city?: string;
  /** The filed coordinates as text, kept when validation drops the decimal pair. */
  coordinatesDms?: string;
  county?: string;
  groundElevationM?: number;
  latitude?: number;
  locationClassCode?: string;
  locationNumber: number;
  /** Absent when the filing leaves the location type blank. */
  locationTypeCode?: string;
  locationTypeLabel?: string;
  longitude?: number;
  name?: string;
  overallHeightM?: number;
  radiusKm?: number;
  /** Filed state, or the state derived from the coordinates when the filing leaves it blank. */
  state?: string;
  stateFromCoordinates?: boolean;
  structureType?: string;
  supportHeightM?: number;
}

/** The full license record of `getLicense`. */
export interface LicenseDetail {
  amateur?: {
    operatorClass?: string;
    operatorClassLabel?: string;
    previousCallsign?: string;
    trusteeCallsign?: string;
    /** `null` when a trustee name exists but redaction withholds it. */
    trusteeName?: string | null;
  };
  callsign?: string;
  cancellationDate?: string;
  effectiveDate?: string;
  expiredDate?: string;
  grantDate?: string;
  isLease: boolean;
  lastActionDate?: string;
  leaseCount: number;
  /** Parent licenses this lease is carved from. */
  leasedFrom: { callsign?: string; usi: string }[];
  /** Leases carved from this license, up to 25; `leaseCount` has the total. */
  leases: { callsign?: string; licenseStatus: string; usi: string }[];
  licensee: {
    applicantType?: string;
    city?: string;
    frn?: string;
    name: string | null;
    redacted: boolean;
    role: 'licensee' | 'lessee';
    state?: string;
  };
  licenseStatus: string;
  market?: {
    blocks: { highMhz: number; lowMhz: number }[];
    channelBlock?: string;
    marketCode: string;
    marketName?: string;
  };
  radioServiceCode: string;
  radioServiceLabel: string;
  serviceGroup: string;
  statusLabel: string;
  usi: string;
}

/** `getLicense` parameters: exactly one of `callsign` or `usi` (checked by the tool). */
export interface GetLicenseParams {
  callsign?: string | undefined;
  maxFrequencies: number;
  usi?: string | undefined;
}

/** `getLicense` outcome: a miss is a result carrying callsign-prefix candidates. */
export type GetLicenseResult =
  | {
      candidates: { callsign: string; licenseStatus: string; usi: string }[];
      found: false;
    }
  | {
      found: true;
      /** Frequency rows returned after the `maxFrequencies` cap. */
      frequenciesShown: number;
      /** Frequency rows the record holds. */
      frequencyTotal: number;
      license: LicenseDetail;
      locations: LicenseLocation[];
      otherCallsignRecords: { licenseStatus: string; usi: string }[];
      /** False for a non-live record, whose sites and frequencies are not kept. */
      technicalRetained: boolean;
    };

/** One frequency at a site after collapsing antennas and modulation steps. */
export interface SiteFrequency {
  bandwidthMhz?: number;
  emissions: string[];
  frequencyMhz: number;
  maxEirpDbm?: number;
  maxErpW?: number;
  stationClasses: string[];
  upperMhz?: number;
}

/** One `find_transmitters` site. */
export interface TransmitterSite extends LicenseeFields {
  asrNumber?: string;
  callsign?: string;
  county?: string;
  distanceKm: number;
  frequencies: SiteFrequency[];
  frequenciesShown: number;
  /** Collapsed frequencies at the site (band-overlapping only when a band is given). */
  frequencyCount: number;
  groundElevationM?: number;
  isLease: boolean;
  latitude: number;
  licenseStatus: string;
  locationNumber: number;
  locationTypeCode?: string;
  longitude: number;
  overallHeightM?: number;
  radioServiceCode: string;
  radioServiceLabel: string;
  state?: string;
  stateFromCoordinates?: boolean;
  usi: string;
}

/** `findTransmitters` parameters. */
export interface FindTransmittersParams {
  band?: Band | undefined;
  cursor?: string | undefined;
  latitude: number;
  limit: number;
  longitude: number;
  maxFrequenciesPerSite: number;
  radioService?: string | undefined;
  radiusKm: number;
  status: LiveStatusFilter;
}

/** One `search_frequencies` row: a site assignment or a market-area spectrum block. */
export interface FrequencyAssignment extends LicenseeFields {
  bandwidthMhz?: number;
  callsign?: string;
  channelBlock?: string;
  county?: string;
  emissions?: string[];
  frequencyMhz: number;
  isLease: boolean;
  kind: 'site' | 'market';
  latitude?: number;
  licenseStatus: string;
  locationNumber?: number;
  longitude?: number;
  marketCode?: string;
  marketName?: string;
  maxErpW?: number;
  radioServiceCode: string;
  radioServiceLabel: string;
  state?: string;
  stateFromCoordinates?: boolean;
  stationClasses?: string[];
  upperMhz?: number;
  usi: string;
}

/** `searchFrequencies` parameters. */
export interface SearchFrequenciesParams {
  band: Band;
  cursor?: string | undefined;
  kind: 'site' | 'market' | 'both';
  licensee?: string | undefined;
  limit: number;
  radioService?: string | undefined;
  state?: string | undefined;
  status: LiveStatusFilter;
}

/** Build state of the local index. */
export interface IndexState {
  dataAsOf?: string;
  error?: string;
  generation?: string;
  lastDailyApplied?: string;
  lastFullBuild?: string;
  ready: boolean;
  status: 'none' | 'building' | 'ready';
}

/** Coverage of one weekly service group. */
export interface GroupCoverage {
  frequencies?: number;
  group: string;
  indexed: boolean;
  records?: number;
  sites?: number;
  snapshotCreated?: string;
}

/** The `coverage` report. */
export interface Coverage {
  groups: GroupCoverage[];
  index: IndexState;
  redactIndividuals: boolean;
}

/** An indexed radio service code with its group and record count. */
export interface IndexedServiceCode {
  group: string;
  records: number;
}
