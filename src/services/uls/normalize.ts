/**
 * @fileoverview Pure normalizers shared by tool inputs and the ingester: callsign,
 * FRN, state, status, and unit spellings; frequency unit conversion; and the
 * degrees-minutes-seconds coordinate rule.
 * @module services/uls/normalize
 */

import { STATE_NAME_TO_CODE, stateNameKey } from './codes.js';

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

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const DMS_TEXT =
  /^(\d{1,3})\s*(?:°|-|\s)\s*(\d{1,2})\s*(?:'|′|-|\s)\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|''|″)?\s*([NSEW])$/;

/**
 * Parse a coordinate typed as text: a decimal string (`"47.62"`) or a DMS string
 * (`47-37-13.8N`, `47 37 13.8 N`, `47°37'13.8"N`). Returns `undefined` when the text is
 * neither, or when a DMS value fails {@link dmsToDecimal}'s rule.
 */
export function parseCoordinateText(text: string, axis: CoordinateAxis): number | undefined {
  const trimmed = text.trim().toUpperCase();
  if (DECIMAL_TEXT.test(trimmed)) return Number(trimmed);
  const match = DMS_TEXT.exec(trimmed);
  if (!match) return;
  const [, deg, min, sec, dir] = match;
  return dmsToDecimal(Number(deg), Number(min), Number(sec), dir ?? null, axis) ?? undefined;
}

/** Trim, uppercase, drop internal spaces, and strip one trailing portable suffix (`n0call/4` → `N0CALL`). */
export function normalizeCallsign(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\/[A-Z0-9]{1,4}$/, '');
}

/** Strip spaces and hyphens and left-pad up to 10 digits (`1234567` → `0001234567`). */
export function normalizeFrn(raw: string): string {
  const stripped = raw.replace(/[\s-]/g, '');
  return /^\d{1,10}$/.test(stripped) ? stripped.padStart(10, '0') : stripped;
}

/** Uppercase a two-letter code, or map a full state or territory name to its USPS code. */
export function normalizeStateInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_NAME_TO_CODE.get(stateNameKey(trimmed)) ?? trimmed;
}

/** Uppercase a status code, keeping the `any` keyword lowercase. */
export function normalizeStatusInput(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.toLowerCase() === 'any' ? 'any' : trimmed.toUpperCase();
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
