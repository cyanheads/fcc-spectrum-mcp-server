/**
 * @fileoverview Shared tool-input schemas. Each normalization runs in a `z.preprocess`
 * before the pattern check, so the advertised pattern holds for the normalized value
 * and handlers only see canonical values. A default sits inside the preprocess, because
 * a `.default()` outside the pipe is dropped from the advertised `inputSchema`. Callers
 * wrap optional fields in {@link blankAsUnset} and add their own `.describe()`.
 * @module mcp-server/tools/input-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { USPS_CODES } from '@/services/uls/codes.js';
import {
  FREQUENCY_UNITS,
  normalizeCallsign,
  normalizeFrn,
  normalizeStateInput,
  normalizeStatusInput,
  normalizeUnitInput,
  parseCoordinateText,
} from '@/services/uls/normalize.js';

/** A blank or whitespace-only string from a form client is unset, never a value to validate. */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

/** Apply `normalize` to string input only; anything else reaches the inner schema unchanged. */
const normalizedString = (normalize: (raw: string) => string) => (value: unknown) =>
  typeof value === 'string' ? normalize(value) : value;

/** Callsign or lease ID: trimmed, uppercased, spaces dropped, one trailing `/X` portable suffix removed. */
export const callsignSchema = z.preprocess(
  normalizedString(normalizeCallsign),
  z.string().regex(/^[A-Z0-9]{3,10}$/),
);

/** FCC Registration Number: spaces and hyphens stripped, left-padded to 10 digits. */
export const frnSchema = z.preprocess(normalizedString(normalizeFrn), z.string().regex(/^\d{10}$/));

/** Unique system identifier as a decimal string without leading zeros. */
export const usiSchema = z.preprocess(
  normalizedString((raw) => raw.trim()),
  z.string().regex(/^[1-9]\d{0,9}$/),
);

/** Two-letter USPS state or territory code; full names map to their code. */
export const stateSchema = z.preprocess(normalizedString(normalizeStateInput), z.enum(USPS_CODES));

/** Two-character radio service code, trimmed and uppercased. */
export const radioServiceSchema = z.preprocess(
  normalizedString((raw) => raw.trim().toUpperCase()),
  z.string().regex(/^[A-Z0-9]{2}$/),
);

/** Every license status plus `any`, for tools that read all statuses; defaults to `A`. */
export const licenseStatusSchema = z.preprocess(
  normalizedString(normalizeStatusInput),
  z.enum(['A', 'C', 'E', 'L', 'P', 'T', 'X', 'any']).default('A'),
);

/**
 * The live statuses that keep technical records (`A`, `L`, `X`) plus `any` for all three;
 * defaults to `A`.
 */
export const liveStatusSchema = z.preprocess(
  normalizedString(normalizeStatusInput),
  z.enum(['A', 'L', 'X', 'any']).default('A'),
);

/** Frequency unit, case-insensitive; defaults to `MHz`. */
export const unitSchema = z.preprocess(
  normalizedString(normalizeUnitInput),
  z.enum(FREQUENCY_UNITS).default('MHz'),
);

/** A frequency in the tool's `unit`; converted to MHz in the handler. */
export const frequencySchema = z.number().positive();

/** Latitude in decimal degrees; decimal and DMS strings are converted before the bound check. */
export const latitudeSchema = z.preprocess(
  (value) =>
    typeof value === 'string' ? (parseCoordinateText(value, 'latitude') ?? value) : value,
  z.number().min(-90).max(90),
);

/** Longitude in decimal degrees; decimal and DMS strings are converted before the bound check. */
export const longitudeSchema = z.preprocess(
  (value) =>
    typeof value === 'string' ? (parseCoordinateText(value, 'longitude') ?? value) : value,
  z.number().min(-180).max(180),
);

/** Opaque pagination cursor from a previous page; blank means the first page. */
export const cursorSchema = blankAsUnset(
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
);
