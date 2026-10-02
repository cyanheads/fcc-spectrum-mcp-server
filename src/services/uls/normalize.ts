/**
 * @fileoverview Pure normalizers shared by tool inputs, the ingester, and the read path:
 * callsign, FRN, market code, state, status, and unit spellings; frequency unit conversion;
 * the degrees-minutes-seconds coordinate rule; and the ASR registration-number rule.
 * @module services/uls/normalize
 */

import { LICENSE_STATUSES, STATE_NAME_TO_CODE, stateNameKey } from './codes.js';

/** Which coordinate a DMS value describes; decides the valid hemispheres and bound. */
export type CoordinateAxis = 'latitude' | 'longitude';

/** Frequency units accepted on tool input. */
export const FREQUENCY_UNITS = ['kHz', 'MHz', 'GHz'] as const;

/** A frequency unit accepted on tool input. */
export type FrequencyUnit = (typeof FREQUENCY_UNITS)[number];

/** Highest frequency a tool accepts, in MHz (300 GHz). */
export const MAX_FREQUENCY_MHZ = 300_000;

const HEMISPHERES: Record<CoordinateAxis, { positive: string; negative: string; max: number }> = {
  latitude: { positive: 'N', negative: 'S', max: 90 },
  longitude: { positive: 'E', negative: 'W', max: 180 },
};

/**
 * Convert degrees, minutes, seconds, and a hemisphere letter to signed decimal degrees.
 * Returns `null` unless every part is present and valid: `0 ≤ min < 60`, `0 ≤ sec < 60`,
 * a hemisphere matching the axis, and a result within ±90 (latitude) or ±180 (longitude).
 */
export function dmsToDecimal(
  degrees: number | null,
  minutes: number | null,
  seconds: number | null,
  hemisphere: string | null,
  axis: CoordinateAxis,
): number | null {
  if (degrees === null || minutes === null || seconds === null || hemisphere === null) return null;
  const { positive, negative, max } = HEMISPHERES[axis];
  const direction = hemisphere.toUpperCase();
  if (direction !== positive && direction !== negative) return null;
  if (degrees < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
  const decimal = degrees + minutes / 60 + seconds / 3600;
  if (decimal > max) return null;
  return direction === negative ? -decimal : decimal;
}

/** A placeholder filed in the registration-number form; issued numbers run far below it. */
const ASR_PLACEHOLDER = '9999999';

/**
 * The filed Antenna Structure Registration value when it is a registration number: seven
 * digits, the FCC's format, other than the `9999999` placeholder. Anything else filed in the
 * field (`N/A`, an `A`-prefixed application file number, a numeric of another length) is
 * `null`, as an unfiled one is.
 */
export function asrRegistrationNumber(filed: string | null): string | null {
  return filed !== null && /^\d{7}$/.test(filed) && filed !== ASR_PLACEHOLDER ? filed : null;
}

/** Longest coordinate text read; longer text is never a coordinate and is left to the schema. */
export const MAX_COORDINATE_TEXT_LENGTH = 48;

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
/**
 * DMS over text whose whitespace runs are collapsed to one space. Each separator is a mark
 * with at most one space on either side, or a lone space, so no two parts of the pattern
 * can claim the same character and a failed match never backtracks across a run.
 */
const DMS_TEXT =
  /^(\d{1,3})(?: ?[°-] ?| )(\d{1,2})(?: ?['′-] ?| )(\d{1,2}(?:\.\d+)?)(?: ?(?:"|''|″))? ?([NSEW])$/;

/**
 * Parse a coordinate typed as text: a decimal string (`"47.62"`) or a DMS string
 * (`47-37-13.8N`, `47 37 13.8 N`, `47°37'13.8"N`). Returns `undefined` when the text is
 * neither, when it is longer than {@link MAX_COORDINATE_TEXT_LENGTH} (checked before any
 * pattern runs), or when a DMS value fails {@link dmsToDecimal}'s rule.
 */
export function parseCoordinateText(text: string, axis: CoordinateAxis): number | undefined {
  if (text.length > MAX_COORDINATE_TEXT_LENGTH) return;
  const trimmed = text.trim().toUpperCase().replace(/\s+/g, ' ');
  if (DECIMAL_TEXT.test(trimmed)) return Number(trimmed);
  const match = DMS_TEXT.exec(trimmed);
  if (!match) return;
  const [, deg, min, sec, dir] = match;
  return dmsToDecimal(Number(deg), Number(min), Number(sec), dir ?? null, axis) ?? undefined;
}

/**
 * Trim, uppercase, drop internal spaces, and strip one trailing portable suffix (`n0call/4` →
 * `N0CALL`, `W1AW/KH6` → `W1AW`). A trailing segment shaped like a callsign (letters, a digit,
 * letters: `KH6/W1AW`) is the base of a prefix-portable form, not a suffix, so it stays for
 * the pattern check to reject.
 */
export function normalizeCallsign(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\/(?![A-Z]{1,2}\d[A-Z]+$)[A-Z0-9]{1,4}$/, '');
}

/** Strip spaces and hyphens and left-pad up to 10 digits (`1234567` → `0001234567`). */
export function normalizeFrn(raw: string): string {
  const stripped = raw.replace(/[\s-]/g, '');
  return /^\d{1,10}$/.test(stripped) ? stripped.padStart(10, '0') : stripped;
}

/**
 * Trim, uppercase, drop spaces and hyphens, and left-pad the digits of a letters-then-digits
 * code with zeros to six characters, the width of every ULS market code but `NW` (`pea16` →
 * `PEA016`, `d6037` → `D06037`, `tl4` → `TL0004`). Other text is left for the pattern check.
 */
export function normalizeMarketCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(
      /^([A-Z]+)(\d+)$/,
      (_, letters: string, digits: string) =>
        `${letters}${digits.padStart(6 - letters.length, '0')}`,
    );
}

/** Uppercase a two-letter code, or map a full state or territory name to its USPS code. */
export function normalizeStateInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_NAME_TO_CODE.get(stateNameKey(trimmed)) ?? trimmed;
}

/** Lowercase, single-spaced, US spelling (`Cancelled` → `canceled`). */
const statusWordKey = (text: string) =>
  text.trim().toLowerCase().replace(/\s+/g, ' ').replaceAll('cancelled', 'canceled');

/**
 * Status words that name exactly one ULS code: each status label (`expired`, `term pending`)
 * plus `pending legal`, the shorter form the tool descriptions use. `pending` alone names
 * both `L` and `X`, so it is not here.
 */
const STATUS_WORDS = new Map([
  ...Object.entries(LICENSE_STATUSES).map(([code, label]) => [statusWordKey(label), code] as const),
  ['pending legal', 'L'],
]);

/** Uppercase a status code or map a one-to-one status word to it, keeping `any` lowercase. */
export function normalizeStatusInput(raw: string): string {
  const key = statusWordKey(raw);
  if (key === 'any') return 'any';
  return STATUS_WORDS.get(key) ?? raw.trim().toUpperCase();
}

/** Map any casing of a unit to its canonical spelling (`mhz` → `MHz`); unknown text passes through. */
export function normalizeUnitInput(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return FREQUENCY_UNITS.find((unit) => unit.toLowerCase() === lower) ?? raw;
}

/** Convert a frequency in `unit` to MHz. */
export function toMhz(value: number, unit: FrequencyUnit): number {
  switch (unit) {
    case 'kHz':
      return value / 1000;
    case 'GHz':
      return value * 1000;
    case 'MHz':
      return value;
  }
}

/** A query band in MHz, or the reason it cannot be one. */
export type BandResult =
  | { ok: true; lowMhz: number; highMhz: number }
  | { ok: false; reason: 'high_without_low' | 'high_below_low' | 'above_max' };

/**
 * Resolve tool frequency inputs to a band in MHz: a single frequency when `high` is
 * omitted, `[low, high]` otherwise. Fails when `high` has no `low`, when `high < low`,
 * or when either edge exceeds {@link MAX_FREQUENCY_MHZ}.
 */
export function resolveBand(
  low: number | undefined,
  high: number | undefined,
  unit: FrequencyUnit,
): BandResult | undefined {
  if (low === undefined) {
    return high === undefined ? undefined : { ok: false, reason: 'high_without_low' };
  }
  const lowMhz = toMhz(low, unit);
  const highMhz = high === undefined ? lowMhz : toMhz(high, unit);
  if (highMhz < lowMhz) return { ok: false, reason: 'high_below_low' };
  if (highMhz > MAX_FREQUENCY_MHZ) return { ok: false, reason: 'above_max' };
  return { ok: true, lowMhz, highMhz };
}
