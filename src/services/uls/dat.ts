/**
 * @fileoverview ULS `.dat` record parsing: UTF-8 line streaming, field-count-checked
 * record splitting, typed decoders for every ingested record type (1-based positions
 * from the ULS public-access layouts), the DMS coordinate rule, emission-designator
 * bandwidth, and the `counts` file header.
 * @module services/uls/dat
 */

import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { type CoordinateAxis, dmsToDecimal } from './normalize.js';

/** Fields per line for every record type the ingester reads. */
export const RECORD_FIELD_COUNTS = {
  HD: 59,
  EN: 30,
  AM: 18,
  LL: 7,
  LO: 51,
  AN: 38,
  FR: 30,
  EM: 16,
  MK: 23,
  MF: 10,
} as const;

/** A record type the ingester reads (`HD.dat`, `EN.dat`, …). */
export type RecordType = keyof typeof RECORD_FIELD_COUNTS;

/** The pipe-split fields of one line, index 0 holding the record type. */
export type RecordFields = readonly string[];

/**
 * Stream UTF-8 text lines from a byte source. Decoding is non-fatal (a malformed
 * sequence becomes U+FFFD rather than aborting the file); lines split on `\n` with one
 * trailing `\r` stripped; empty lines are skipped.
 */
export async function* readLines(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  for await (const chunk of source) {
    pending += decoder.decode(chunk, { stream: true });
    let start = 0;
    let newline = pending.indexOf('\n', start);
    while (newline !== -1) {
      const line = stripCarriageReturn(pending.slice(start, newline));
      if (line) yield line;
      start = newline + 1;
      newline = pending.indexOf('\n', start);
    }
    pending = pending.slice(start);
  }
  pending += decoder.decode();
  const last = stripCarriageReturn(pending);
  if (last) yield last;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Split a line into its fields when it is a well-formed `type` record: the first field
 * names the type and the field count matches the layout. Returns `null` otherwise, so
 * the caller counts the line as rejected instead of guessing positions.
 */
export function splitRecord(line: string, type: RecordType): RecordFields | null {
  const fields = line.split('|');
  if (fields.length !== RECORD_FIELD_COUNTS[type] || fields[0] !== type) return null;
  return fields;
}

/** Field `position` (1-based) as trimmed text, or `null` when empty. */
export function textField(fields: RecordFields, position: number): string | null {
  const value = fields[position - 1]?.trim();
  return value ? value : null;
}

/** Field `position` (1-based) as a finite number, or `null` when empty or non-numeric. */
export function numberField(fields: RecordFields, position: number): number | null {
  const text = textField(fields, position);
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Field `position` (1-based) as an ISO `YYYY-MM-DD` date from ULS `MM/DD/YYYY`, or `null`. */
export function dateField(fields: RecordFields, position: number): string | null {
  return parseUlsDate(textField(fields, position));
}

/** Convert a ULS `MM/DD/YYYY` date to `YYYY-MM-DD`; anything else is `null`. */
export function parseUlsDate(text: string | null): string | null {
  const match = text ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text) : null;
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year}-${month}-${day}`;
}

/** A decoded coordinate: decimal degrees when the DMS parts pass the rule, and the raw text. */
export interface DecodedCoordinate {
  /** Signed decimal degrees, or `null` when any part is missing or out of range. */
  decimal: number | null;
  /**
   * The filed value as `DD-MM-SS.s H`, or `null` when degrees, minutes, and seconds are
   * all blank (a hemisphere letter alone carries no position).
   */
  dms: string | null;
}

/** Decode four consecutive DMS fields (degrees, minutes, seconds, direction) starting at `position`. */
export function coordinateFields(
  fields: RecordFields,
  position: number,
  axis: CoordinateAxis,
): DecodedCoordinate {
  const parts = [0, 1, 2, 3].map((offset) => textField(fields, position + offset));
  const [deg, min, sec, dir] = parts;
  const dms = [deg, min, sec].some((part) => part !== null)
    ? `${deg ?? ''}-${min ?? ''}-${sec ?? ''} ${dir ?? ''}`.trim()
    : null;
  const decimal = dmsToDecimal(
    numberField(fields, position),
    numberField(fields, position + 1),
    numberField(fields, position + 2),
    dir ?? null,
    axis,
  );
  return { decimal, dms };
}

const BANDWIDTH_TO_MHZ: Record<string, (value: number) => number> = {
  H: (value) => value / 1e6,
  K: (value) => value / 1e3,
  M: (value) => value,
  G: (value) => value * 1e3,
};

/**
 * Necessary bandwidth in MHz from an emission designator's first four characters, where
 * the letter H/K/M/G marks both the decimal point and the unit (`6M00D1D` → 6,
 * `11K2F3E` → 0.0112). Uppercased first; `null` when the prefix does not parse.
 */
export function emissionBandwidthMhz(designator: string): number | null {
  const match = /^(\d*)([HKMG])(\d*)$/.exec(designator.trim().toUpperCase().slice(0, 4));
  if (!match) return null;
  const [, whole = '', unit = '', fraction = ''] = match;
  if (whole.length + fraction.length !== 3) return null;
  const value = Number(`${whole || '0'}.${fraction || '0'}`);
  const convert = BANDWIDTH_TO_MHZ[unit];
  return convert && Number.isFinite(value) ? convert(value) : null;
}

/**
 * A designator whose bandwidth is this fraction of the assigned frequency or more is a
 * filing error (`5G75C3F` on 470 MHz) and is left out of the bandwidth and occupied band.
 * It is the fractional-bandwidth leg of the ultra-wideband definition in 47 CFR 15.503(d);
 * licensed ULS stations are not ultra-wideband.
 */
export const MAX_FRACTIONAL_BANDWIDTH = 0.2;

/**
 * Occupied band of a site assignment in MHz: `[f − bw/2, (upper ?? f) + bw/2]`, where
 * `bw` is the widest necessary bandwidth among its emissions (0 when none parses).
 */
export function occupiedBand(
  frequencyMhz: number,
  upperMhz: number | null,
  bandwidthMhz: number | null,
): { low: number; high: number } {
  const half = (bandwidthMhz ?? 0) / 2;
  return { low: frequencyMhz - half, high: (upperMhz ?? frequencyMhz) + half };
}

/** A parsed `counts` file: its creation time and per-record-type line counts. */
export interface CountsFile {
  /** Line count keyed by uppercased record type (`HD`, `LL`, …). */
  counts: Record<string, number>;
  /** Creation time as fixed-width UTC ISO 8601 (`2026-09-27T13:38:53Z`). */
  createdAt: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ZONE_OFFSET_HOURS: Record<string, number> = { EDT: -4, EST: -5 };

/**
 * Parse a ULS `counts` file: `File Creation Date: Sun Sep 27 09:38:53 EDT 2026`, then
 * `<count> <path>/<TYPE>.dat` lines. Throws `SerializationError` on a header it cannot read.
 */
export function parseCountsFile(text: string): CountsFile {
  const lines = text.split('\n').map(stripCarriageReturn);
  const header =
    /^File Creation Date:\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([A-Z]{3})\s+(\d{4})\s*$/.exec(
      lines[0] ?? '',
    );
  const month = header ? MONTHS.indexOf(header[1] ?? '') : -1;
  const offset = header ? ZONE_OFFSET_HOURS[header[6] ?? ''] : undefined;
  if (!header || month === -1 || offset === undefined) {
    throw serializationError('Unreadable ULS counts header.', { header: lines[0]?.slice(0, 120) });
  }
  const [, , day, hour, minute, second, , year] = header;
  const utc = Date.UTC(
    Number(year),
    month,
    Number(day),
    Number(hour) - offset,
    Number(minute),
    Number(second),
  );
  const counts: Record<string, number> = {};
  for (const line of lines.slice(1)) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const file = (match[2] ?? '').split('/').pop() ?? '';
    const type = file.replace(/\.dat$/i, '').toUpperCase();
    if (type) counts[type] = Number(match[1]);
  }
  return { createdAt: toIsoSeconds(utc), counts };
}

/** Format epoch milliseconds as fixed-width UTC ISO 8601 without fractional seconds. */
export function toIsoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * HD — license header. This and the decoders below return `null` for a malformed line
 * (wrong type, wrong field count, or a missing key field) so the ingester counts it as
 * rejected.
 */
export interface HdRecord {
  callsign: string | null;
  cancellationDate: string | null;
  effectiveDate: string | null;
  expiredDate: string | null;
  grantDate: string | null;
  lastActionDate: string | null;
  licenseStatus: string | null;
  radioServiceCode: string | null;
  usi: number;
}

/**
 * Decode an HD line. The license status is upper-cased: ULS files the odd one in lower case
 * (`c`), which would miss its label and, for a live status, the live-status filter.
 */
export function decodeHd(line: string): HdRecord | null {
  const f = splitRecord(line, 'HD');
  const usi = f && numberField(f, 2);
  if (!f || usi === null) return null;
  return {
    usi,
    callsign: textField(f, 5),
    licenseStatus: textField(f, 6)?.toUpperCase() ?? null,
    radioServiceCode: textField(f, 7),
    grantDate: dateField(f, 8),
    expiredDate: dateField(f, 9),
    cancellationDate: dateField(f, 10),
    effectiveDate: dateField(f, 43),
    lastActionDate: dateField(f, 44),
  };
}

/**
 * EN — entity. Only the name, city, state, FRN, and applicant type are read; street
 * address, ZIP, PO box, attention line, phone, fax, email, and split name parts never are.
 */
export interface EnRecord {
  applicantType: string | null;
  city: string | null;
  entityName: string | null;
  /** `L` licensee (the lessee on a lease), `CL` contact, `O` owner, … */
  entityType: string | null;
  frn: string | null;
  state: string | null;
  usi: number;
}

/** Decode an EN line. */
export function decodeEn(line: string): EnRecord | null {
  const f = splitRecord(line, 'EN');
  const usi = f && numberField(f, 2);
  if (!f || usi === null) return null;
  return {
    usi,
    entityType: textField(f, 6),
    entityName: textField(f, 8),
    city: textField(f, 17),
    state: textField(f, 18),
    frn: textField(f, 23),
    applicantType: textField(f, 24),
  };
}

/** AM — amateur. */
export interface AmRecord {
  operatorClass: string | null;
  previousCallsign: string | null;
  trusteeCallsign: string | null;
  trusteeName: string | null;
  usi: number;
}

/** Decode an AM line. */
export function decodeAm(line: string): AmRecord | null {
  const f = splitRecord(line, 'AM');
  const usi = f && numberField(f, 2);
  if (!f || usi === null) return null;
  return {
    usi,
    operatorClass: textField(f, 6),
    trusteeCallsign: textField(f, 9),
    previousCallsign: textField(f, 16),
    trusteeName: textField(f, 18),
  };
}

/** LL — lease link: a lease's USI and the parent license it is carved from. */
export interface LlRecord {
  leaseId: string | null;
  leaseUsi: number;
  parentCallsign: string | null;
  parentUsi: number;
}

/** Decode an LL line. */
export function decodeLl(line: string): LlRecord | null {
  const f = splitRecord(line, 'LL');
  const leaseUsi = f && numberField(f, 2);
  const parentUsi = f && numberField(f, 7);
  if (!f || leaseUsi === null || parentUsi === null) return null;
  return { leaseUsi, parentCallsign: textField(f, 5), leaseId: textField(f, 6), parentUsi };
}

/** LO — location. Coordinates are decoded under the DMS rule; `site_state` derivation is the ingester's. */
export interface LoRecord {
  address: string | null;
  asrNumber: string | null;
  city: string | null;
  /** Filed coordinates as text (`47-37-13.8 N 122-20-57.5 W`), kept when validation drops the decimals. */
  coordinatesDms: string | null;
  county: string | null;
  groundElevationM: number | null;
  latitude: number | null;
  locationClassCode: string | null;
  locationName: string | null;
  locationNumber: number;
  locationTypeCode: string | null;
  longitude: number | null;
  overallHeightM: number | null;
  radiusOfOperationKm: number | null;
  state: string | null;
  structureType: string | null;
  supportHeightM: number | null;
  usi: number;
}

/** Decode an LO line. */
export function decodeLo(line: string): LoRecord | null {
  const f = splitRecord(line, 'LO');
  const usi = f && numberField(f, 2);
  const locationNumber = f && numberField(f, 9);
  if (!f || usi === null || locationNumber === null) return null;
  const lat = coordinateFields(f, 20, 'latitude');
  const lon = coordinateFields(f, 24, 'longitude');
  const located = lat.decimal !== null && lon.decimal !== null;
  const dms = [lat.dms, lon.dms].filter((part) => part !== null).join(' ');
  return {
    usi,
    locationNumber,
    locationTypeCode: textField(f, 7),
    locationClassCode: textField(f, 8),
    address: textField(f, 12),
    city: textField(f, 13),
    county: textField(f, 14),
    state: textField(f, 15),
    radiusOfOperationKm: numberField(f, 16),
    groundElevationM: numberField(f, 19),
    latitude: located ? lat.decimal : null,
    longitude: located ? lon.decimal : null,
    coordinatesDms: dms || null,
    asrNumber: textField(f, 38),
    supportHeightM: numberField(f, 39),
    overallHeightM: numberField(f, 40),
    structureType: textField(f, 41),
    locationName: textField(f, 43),
  };
}

/** AN — antenna. */
export interface AnRecord {
  antennaNumber: number;
  antennaTypeCode: string | null;
  azimuthDeg: number | null;
  beamwidthDeg: number | null;
  gainDbi: number | null;
  haatM: number | null;
  heightToCenterM: number | null;
  heightToTipM: number | null;
  locationNumber: number;
  make: string | null;
  model: string | null;
  polarization: string | null;
  usi: number;
}

/** Decode an AN line. */
export function decodeAn(line: string): AnRecord | null {
  const f = splitRecord(line, 'AN');
  const usi = f && numberField(f, 2);
  const antennaNumber = f && numberField(f, 7);
  const locationNumber = f && numberField(f, 8);
  if (!f || usi === null || antennaNumber === null || locationNumber === null) return null;
  return {
    usi,
    antennaNumber,
    locationNumber,
    antennaTypeCode: textField(f, 10),
    heightToTipM: numberField(f, 11),
    heightToCenterM: numberField(f, 12),
    make: textField(f, 13),
    model: textField(f, 14),
    polarization: textField(f, 16),
    beamwidthDeg: numberField(f, 17),
    gainDbi: numberField(f, 18),
    azimuthDeg: numberField(f, 19),
    haatM: numberField(f, 20),
  };
}

/** FR — frequency. */
export interface FrRecord {
  antennaNumber: number;
  classStationCode: string | null;
  eirpDbm: number | null;
  erpW: number | null;
  freqSeqId: number;
  frequencyMhz: number | null;
  locationNumber: number;
  powerOutputW: number | null;
  transmitterMake: string | null;
  transmitterModel: string | null;
  upperMhz: number | null;
  usi: number;
}

/** Decode an FR line. */
export function decodeFr(line: string): FrRecord | null {
  const f = splitRecord(line, 'FR');
  const usi = f && numberField(f, 2);
  const locationNumber = f && numberField(f, 7);
  const antennaNumber = f && numberField(f, 8);
  const freqSeqId = f && numberField(f, 27);
  if (
    !f ||
    usi === null ||
    locationNumber === null ||
    antennaNumber === null ||
    freqSeqId === null
  ) {
    return null;
  }
  return {
    usi,
    locationNumber,
    antennaNumber,
    classStationCode: textField(f, 9),
    frequencyMhz: numberField(f, 11),
    upperMhz: numberField(f, 12),
    powerOutputW: numberField(f, 16),
    erpW: numberField(f, 17),
    eirpDbm: numberField(f, 21),
    transmitterMake: textField(f, 22),
    transmitterModel: textField(f, 23),
    freqSeqId,
  };
}

/** EM — emission designator, joined to its FR row on `(usi, location, antenna, freqSeqId)`. */
export interface EmRecord {
  antennaNumber: number;
  emissionCode: string;
  /** The `freqSeqId` of the FR row this emission belongs to (EM field 13). */
  freqSeqId: number;
  frequencyMhz: number | null;
  locationNumber: number;
  usi: number;
}

/** Decode an EM line. */
export function decodeEm(line: string): EmRecord | null {
  const f = splitRecord(line, 'EM');
  const usi = f && numberField(f, 2);
  const locationNumber = f && numberField(f, 6);
  const antennaNumber = f && numberField(f, 7);
  const emissionCode = f && textField(f, 10);
  const freqSeqId = f && numberField(f, 13);
  if (
    !f ||
    usi === null ||
    locationNumber === null ||
    antennaNumber === null ||
    emissionCode === null ||
    freqSeqId === null
  ) {
    return null;
  }
  return {
    usi,
    locationNumber,
    antennaNumber,
    frequencyMhz: numberField(f, 8),
    emissionCode,
    freqSeqId,
  };
}

/** MK — market. `marketName` is cut at 30 characters by ULS. */
export interface MkRecord {
  channelBlock: string | null;
  marketCode: string | null;
  marketName: string | null;
  usi: number;
}

/** Decode an MK line. */
export function decodeMk(line: string): MkRecord | null {
  const f = splitRecord(line, 'MK');
  const usi = f && numberField(f, 2);
  if (!f || usi === null) return null;
  return {
    usi,
    marketCode: textField(f, 6),
    channelBlock: textField(f, 7),
    marketName: textField(f, 9),
  };
}

/** MF — market frequency block. Only `usi` and `lowerMhz` are required; a blank partition area stays `null`. */
export interface MfRecord {
  lowerMhz: number;
  partitionAreaId: number | null;
  upperMhz: number | null;
  usi: number;
}

/** Decode an MF line. */
export function decodeMf(line: string): MfRecord | null {
  const f = splitRecord(line, 'MF');
  const usi = f && numberField(f, 2);
  const lowerMhz = f && numberField(f, 7);
  if (!f || usi === null || lowerMhz === null) return null;
  return { usi, partitionAreaId: numberField(f, 6), lowerMhz, upperMhz: numberField(f, 8) };
}
