/**
 * @fileoverview Markdown helpers shared by the tools' `format()` functions: flattening
 * upstream-authored text for inline slots and preserving its literal CommonMark rendering,
 * escaping table cells, and rendering the values every data tool repeats (callsigns,
 * licensee names, state sources, frequency bands, applied filters, option lists).
 * @module mcp-server/tools/format-helpers
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

const flatten = (text: string) => text.replace(/[\r\n]+/g, ' ');

/**
 * Registry text rendered literally in an inline Markdown slot, with CR/LF runs flattened
 * to one space. Server-authored Markdown stays outside this boundary.
 */
export const inline = (text: string) => escapeMarkdownInline(flatten(text));

/** Registry text rendered literally in a Markdown table cell, with CR/LF runs flattened. */
export const cell = inline;

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
 * JSON-quoted and escaped, so free text stays visibly delimited and renders literally.
 */
export function renderAppliedFilters(filters: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'string' ? inline(JSON.stringify(value)) : value}`,
    );
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
