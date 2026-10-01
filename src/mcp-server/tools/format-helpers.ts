/**
 * @fileoverview Markdown helpers shared by the tools' `format()` functions: flattening
 * upstream-authored text for inline slots and escaping its link, image, and HTML syntax,
 * escaping table cells, and rendering the values every data tool repeats (callsigns,
 * licensee names, state sources, frequency bands, applied filters, option lists).
 * @module mcp-server/tools/format-helpers
 */

const flatten = (text: string) => text.replace(/[\r\n]+/g, ' ');

/**
 * Registry text for an inline markdown slot: CR/LF runs flattened to one space, and `[`, `]`,
 * `<`, and `>` backslash-escaped so a filed name renders as text, never as a link, image, or
 * HTML. A backslash run right before one of them is doubled, so a filed backslash cannot
 * cancel the escape. Everything else stays as filed, so names read cleanly as raw text.
 */
export const inline = (text: string) =>
  flatten(text).replace(
    /(\\*)([[\]<>])/g,
    (_match, slashes: string, char: string) => `${slashes}${slashes}\\${char}`,
  );

/** Registry text for a markdown table cell: every backslash, pipe, bracket, and angle bracket escaped. */
export const cell = (text: string) => flatten(text).replace(/[\\|[\]<>]/g, '\\$&');

/** A boolean as `yes`/`no`. */
export const yesNo = (value: boolean) => (value ? 'yes' : 'no');

/** A callsign for display; the few records filed without one read `(no callsign)`. */
export const callsignText = (callsign: string | undefined) =>
  callsign ? inline(callsign) : '(no callsign)';

/** A licensee name for display, distinguishing a redacted individual from a name ULS never filed. */
export function licenseeText(name: string | null, redacted: boolean): string {
  if (name !== null) return inline(name);
  return redacted ? 'Redacted (individual licensee)' : 'Not on file';
}

/** Where a site's state came from, as a suffix: derived, as filed, or nothing when unknown. */
export function stateSourceText(stateFromCoordinates: boolean | undefined): string {
  if (stateFromCoordinates === undefined) return '';
  return stateFromCoordinates ? ' (state derived from coordinates)' : ' (state as filed)';
}

/** A frequency or band in MHz: `851.0125 MHz` or `851–869 MHz`. */
export function bandText(lowMhz: number, highMhz?: number): string {
  return highMhz === undefined || highMhz === lowMhz ? `${lowMhz} MHz` : `${lowMhz}–${highMhz} MHz`;
}

/**
 * One markdown line for an `appliedFilters` enrichment object. Caller-supplied strings are
 * JSON-quoted, so free text stays visibly delimited and cannot break the line.
 */
export function renderAppliedFilters(filters: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : value}`);
  return `**Applied filters:** ${parts.length ? parts.join(' · ') : 'none'}`;
}

/** Join the options that apply as `a, b, or c`; `undefined` when none does. */
export function orList(options: readonly (string | false | undefined)[]): string | undefined {
  const kept = options.filter((option): option is string => Boolean(option));
  if (kept.length <= 1) return kept[0];
  return kept.length === 2
    ? `${kept[0]} or ${kept[1]}`
    : `${kept.slice(0, -1).join(', ')}, or ${kept.at(-1)}`;
}
