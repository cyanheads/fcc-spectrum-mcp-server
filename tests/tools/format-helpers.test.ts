/**
 * @fileoverview Tests for the `format()` helpers: CR/LF flattening for inline slots, table
 * cell escaping, licensee display text, band text, the applied-filters line, and notice
 * composition.
 * @module tests/tools/format-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  bandText,
  cell,
  inline,
  joinNotice,
  licenseeText,
  orList,
  renderAppliedFilters,
  yesNo,
} from '@/mcp-server/tools/format-helpers.js';

describe('inline', () => {
  it.each([
    ['a CR', 'Carriage\rReturn', 'Carriage Return'],
    ['an LF', 'Line\nFeed', 'Line Feed'],
    ['a CRLF run', 'One\r\n\r\nTwo', 'One Two'],
    ['plain text', 'No breaks | here', 'No breaks | here'],
  ])('flattens %s to one space', (_label, input, expected) => {
    expect(inline(input)).toBe(expected);
  });
});

describe('cell', () => {
  it('escapes a pipe so it cannot end the cell', () => {
    expect(cell('A|B')).toBe('A\\|B');
  });

  it('escapes a backslash before the pipe, so an escaped pipe stays escaped', () => {
    expect(cell('A\\|B')).toBe('A\\\\\\|B');
    expect(cell('C:\\dir')).toBe('C:\\\\dir');
  });

  it('flattens CR/LF as well', () => {
    expect(cell('Make\r\nModel | X')).toBe('Make Model \\| X');
  });
});

describe('yesNo', () => {
  it('renders booleans as yes and no', () => {
    expect(yesNo(true)).toBe('yes');
    expect(yesNo(false)).toBe('no');
  });
});

describe('licenseeText', () => {
  it('flattens a filed name', () => {
    expect(licenseeText('Acme\r\nRadio', false)).toBe('Acme Radio');
  });

  it('says a null name was redacted when the record is redacted', () => {
    expect(licenseeText(null, true)).toBe('Redacted (individual licensee)');
  });

  it('says a null name was never filed otherwise', () => {
    expect(licenseeText(null, false)).toBe('Not on file');
  });
});

describe('bandText', () => {
  it('renders one frequency when the upper edge is absent or equal', () => {
    expect(bandText(851.0125)).toBe('851.0125 MHz');
    expect(bandText(152.24, 152.24)).toBe('152.24 MHz');
  });

  it('renders a band with an en dash', () => {
    expect(bandText(851, 869)).toBe('851–869 MHz');
  });
});

describe('renderAppliedFilters', () => {
  it('JSON-quotes strings, prints numbers bare, and drops undefined values', () => {
    expect(
      renderAppliedFilters({
        callsign: 'KZZ901',
        frequency_low_mhz: 152.24,
        radio_service: undefined,
        status: 'A',
      }),
    ).toBe('**Applied filters:** callsign="KZZ901" · frequency_low_mhz=152.24 · status="A"');
  });

  it('keeps free text with CR/LF and quotes on one line', () => {
    const rendered = renderAppliedFilters({ licensee: 'Acme "Radio"\r\nCo' });
    expect(rendered).toBe('**Applied filters:** licensee="Acme \\"Radio\\"\\r\\nCo"');
    expect(rendered).not.toMatch(/[\r\n]/);
  });

  it('says none when no filter applies', () => {
    expect(renderAppliedFilters({})).toBe('**Applied filters:** none');
    expect(renderAppliedFilters({ state: undefined })).toBe('**Applied filters:** none');
  });
});

describe('orList', () => {
  it('returns undefined when no option applies', () => {
    expect(orList([])).toBeUndefined();
    expect(orList([false, undefined, ''])).toBeUndefined();
  });

  it('returns a lone option as is', () => {
    expect(orList([false, 'widen the band'])).toBe('widen the band');
  });

  it('joins two with "or" and more with commas and a final "or"', () => {
    expect(orList(['a', 'b'])).toBe('a or b');
    expect(orList(['a', false, 'b', undefined, 'c'])).toBe('a, b, or c');
  });
});

describe('joinNotice', () => {
  it('returns undefined for no fragments and joins the rest with spaces', () => {
    expect(joinNotice([])).toBeUndefined();
    expect(joinNotice(['First.', 'Second.'])).toBe('First. Second.');
  });
});
