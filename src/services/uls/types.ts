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
  /** True when `total` is a lower bound: the search counted only part of a large match set. */
  totalIsLowerBound?: boolean;
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
  marketCode?: string | undefined;
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
  /**
   * AN records filed under this location and antenna number, when more than one; only the
   * fields every record agrees on are kept.
   */
  recordCount?: number;
}

/** One filed site: an LO record's place, coordinates, and structure. */
export interface LicenseSite {
  /** Street address; omitted on an individual's record while redaction is on. */
  address?: string;
  /** Present only when the filed value is a registration number (seven digits, not `9999999`). */
  asrNumber?: string;
  city?: string;
  /** The filed coordinates as text, kept when validation drops the decimal pair. */
  coordinatesDms?: string;
  county?: string;
  groundElevationM?: number;
  latitude?: number;
  locationClassCode?: string;
  /** Absent when the filing leaves the location type blank. */
  locationTypeCode?: string;
  locationTypeLabel?: string;
  longitude?: number;
  /** Site name; omitted on an individual's record while redaction is on. */
  name?: string;
  overallHeightM?: number;
  radiusKm?: number;
  /** Filed state, or the state derived from the coordinates when the filing leaves it blank. */
  state?: string;
  stateFromCoordinates?: boolean;
  structureType?: string;
  supportHeightM?: number;
}

/**
 * A license location number with its antennas. A number filed at one site carries that
 * site's fields; one the license files at several sites lists them in `sites` instead, and
 * its antennas and frequencies belong to the number, since ULS does not tie them to a site.
 */
export interface LicenseLocation extends LicenseSite {
  antennas: LicenseAntenna[];
  locationNumber: number;
  sites?: LicenseSite[];
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
  /** One page of the leases carved from this license; `leaseCount` has the total. */
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
    /**
     * One entry per band, collapsed across the partition areas it is filed under. A block
     * filed with a 0 lower edge carries `channelWidthMhz` instead of edges.
     */
    blocks: {
      channelWidthMhz?: number;
      highMhz?: number;
      lowMhz?: number;
      partitionAreaIds?: number[];
    }[];
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

/**
 * `getLicense` parameters: the record by exactly one of `callsign` or `usi`, the start of its
 * location window by at most one of `locationOffset` or `locationNumber`, and the page.
 */
export type GetLicenseParams = (
  | { callsign: string; usi?: never }
  | { callsign?: never; usi: string }
) &
  (
    | {
        locationNumber?: never;
        /** Index of the first location number in the window, in number order (default 0). */
        locationOffset?: number;
      }
    | {
        /**
         * Location number the window starts at, as an offset: the count of the record's
         * location numbers below it, so an unfiled number starts at the next filed one.
         */
        locationNumber: number;
        locationOffset?: never;
      }
  ) & {
    /** Index of the first lease listed, in lease-ID order (default 0). */
    leaseOffset?: number;
    maxFrequencies: number;
  };

/** `getLicense` outcome: a miss is a result carrying callsign-prefix candidates. */
export type GetLicenseResult =
  | {
      candidates: { callsign: string; licenseStatus: string; usi: string }[];
      found: false;
    }
  | {
      found: true;
      /** The window's first location missing frequency rows past the cap, and its offset. */
      frequencyCutAt?: { locationNumber: number; offset: number };
      /** Frequency rows returned after the `maxFrequencies` cap. */
      frequenciesShown: number;
      /** Frequency rows the record holds. */
      frequencyTotal: number;
      /** Highest location number the record files; absent when it files none. */
      lastLocationNumber?: number;
      license: LicenseDetail;
      /**
       * Offset of the window's first location number, in number order: `locationOffset`, or
       * the offset `locationNumber` resolved to.
       */
      locationOffset: number;
      /** Location numbers the record files. */
      locationTotal: number;
      /** The window of location numbers, from `locationOffset`. */
      locations: LicenseLocation[];
      /** Offset of the first lease past this page; absent on the last page. */
      nextLeaseOffset?: number;
      /** Offset of the first location number past this window; absent on the last window. */
      nextLocationOffset?: number;
      otherCallsignRecords: { licenseStatus: string; usi: string }[];
      /** Sites the record files, each site of a shared location number counted. */
      siteTotal: number;
      /** Sites in this window. */
      sitesShown: number;
      /** False for a non-live record, whose sites and frequencies are not kept. */
      technicalRetained: boolean;
      /** Frequency rows filed at this window's locations. */
      windowFrequencyTotal: number;
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
  /** Present only when the filed value is a registration number (seven digits, not `9999999`). */
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
  /** The site, or the center of an operating area filed with `radiusKm`. */
  latitude: number;
  licenseStatus: string;
  locationNumber: number;
  /** Absent when the filing leaves the location type blank. */
  locationTypeCode?: string;
  locationTypeLabel?: string;
  longitude: number;
  overallHeightM?: number;
  radioServiceCode: string;
  radioServiceLabel: string;
  /** Radius of operation, filed on any location type (mobile and temporary-fixed areas mostly). */
  radiusKm?: number;
  /**
   * Sites the license files under this location number, when more than one; the
   * frequencies are then the number's, not this site's alone.
   */
  sitesSharingNumber?: number;
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
  /** One ULS location type code; unset matches every type, untyped sites included. */
  locationType?: string | undefined;
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
  /** Site rows at a single site; absent when the filing leaves the type blank. */
  locationTypeCode?: string;
  locationTypeLabel?: string;
  longitude?: number;
  marketCode?: string;
  marketName?: string;
  maxErpW?: number;
  /** Partition areas a market block is filed under (market rows; blank areas dropped). */
  partitionAreaIds?: number[];
  radioServiceCode: string;
  radioServiceLabel: string;
  /** Radius of operation (site rows at a single site, when filed). */
  radiusKm?: number;
  /**
   * Sites the license files under this location number, when more than one (site rows);
   * the row then carries no site coordinates, location type, radius, or place, since ULS
   * does not say which site uses the frequency.
   */
  sitesSharingNumber?: number;
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
  frn?: string | undefined;
  kind: 'site' | 'market' | 'both';
  licensee?: string | undefined;
  limit: number;
  marketCode?: string | undefined;
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
