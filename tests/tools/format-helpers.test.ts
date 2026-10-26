/**
 * @fileoverview Tests for the `format()` helpers: CR/LF flattening and link, image, and HTML
 * escaping for inline slots, table cell escaping, callsign and licensee display text, the
 * state-source suffix, band text,
 * the applied-filters line, and option lists.
 * @module tests/tools/format-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  bandText,
  callsignText,
  cell,
  inline,
  licenseeText,
  orList,
  renderAppliedFilters,
  stateSourceText,
  yesNo,
} from '@/mcp-server/tools/format-helpers.js';
import { markdown, renderedText } from '../fixtures/tool-harness.js';

describe('inline', () => {
  it.each([
    ['emphasis', 'ARKANSAS, STATE OF**GOV**'],
    ['code and underscores', 'Acme *RF* _West_ `HQ`'],
    ['links and HTML', '[Acme](https://x.test) ![x](y) <b>West</b>'],
    ['backslashes and pipes', 'A\\*B \\[C] | D'],
    ['trailing heading hashes', 'Filed #'],
    ['reference definition', '[label]: https://x.test'],
    ['edge whitespace', '\u00a0 Filed \t'],
  ])('preserves literal %s throughout a parsed document', (_label, value) => {
    const document = `## ${inline(value)}\n\n- **Registry:** ${inline(value)}\n\n> ${inline(value)}\n\n| Filed |\n| --- |\n| ${cell(value)} |\n\nAfter.`;
    const visible = renderedText(document);
    expect(visible.split(value)).toHaveLength(5);
    const html = markdown.render(document);
    expect(html).not.toMatch(/<(?:a |img |em>|code>|b>)/);
    expect(html).toContain('<p>After.</p>');
  });
  it('preserves CR/LF flattening and authored formatting in a complete document', () => {
    const document = `## Registry\n\n- **Name:** ${inline('Radio\r\nClub')}\n\n| Code | Label |\n| --- | --- |\n| A | ${cell('Line\r\nTwo | East')} |`;
    expect(renderedText(document)).toBe(
      'Registry\nName: Radio Club\nCode\nLabel\nA\nLine Two | East',
    );
    expect(
      markdown.parse(document, {}).filter((token) => token.type === 'heading_open'),
    ).toHaveLength(1);
  });
  it.each([
    ['a CR', 'Carriage\rReturn', 'Carriage Return'],
    ['an LF', 'Line\nFeed', 'Line Feed'],
    ['a CRLF run', 'One\r\n\r\nTwo', 'One Two'],
    ['plain text', 'No breaks | here', 'No breaks | here'],
  ])('flattens %s to one space', (_label, input, expected) => {
    expect(renderedText(inline(input))).toBe(expected);
  });

  it.each([
    ['a link', '[Acme](https://x.test)'],
    ['an image', '![x](https://x.test/p.png)'],
    ['a reference link', '[Acme][1]'],
    ['an HTML tag', '<img src=x onerror=y>'],
    ['an autolink', '<https://x.test>'],
  ])('makes %s inert', (_label, input) => {
    expect(renderedText(inline(input))).toBe(input);
    expect(markdown.render(inline(input))).not.toMatch(/<(?:a |img |b>)/);
  });

  it('escapes the backslashes before a bracket, so a filed backslash cannot cancel the escape', () => {
    expect(renderedText(inline('\\[Acme](https://x.test)'))).toBe('\\[Acme](https://x.test)');
    expect(renderedText(inline('\\\\<b>'))).toBe('\\\\<b>');
  });

  it('renders parentheses, exclamation marks, backticks, and backslashes as filed', () => {
    expect(renderedText(inline('Acme (West) Radio! `HQ` C:\\dir'))).toBe(
      'Acme (West) Radio! `HQ` C:\\dir',
    );
  });
});

describe('cell', () => {
  it('escapes a pipe so it cannot end the cell', () => {
    expect(cell('A|B')).toBe('A\\|B');
  });

  it('escapes a backslash before the pipe, so an escaped pipe stays escaped', () => {
    expect(cell('A\\|B')).toBe('A\\\\\\|B');
    expect(renderedText(cell('C:\\dir'))).toBe('C:\\dir');
  });

  it('flattens CR/LF as well', () => {
    expect(cell('Make\r\nModel | X')).toBe('Make Model \\| X');
  });

  it('makes link, image, and HTML syntax inert', () => {
    expect(cell('![x](https://x.test)')).toBe('!\\[x\\](https://x.test)');
    expect(renderedText(cell('<b>Acme</b>'))).toBe('<b>Acme</b>');
    expect(markdown.render(cell('<b>Acme</b>'))).not.toContain('<b>');
    expect(cell('\\[Acme](y)')).toBe('\\\\\\[Acme\\](y)');
  });
});

describe('yesNo', () => {
  it('renders booleans as yes and no', () => {
    expect(yesNo(true)).toBe('yes');
    expect(yesNo(false)).toBe('no');
  });
});

describe('callsignText', () => {
  it('flattens a filed callsign and names a missing one', () => {
    expect(callsignText('KZZ\r\n901')).toBe('KZZ 901');
    expect(callsignText(undefined)).toBe('(no callsign)');
  });
});

describe('stateSourceText', () => {
  it('says where the state came from, and nothing when that is unknown', () => {
    expect(stateSourceText(true)).toBe(' (state derived from coordinates)');
    expect(stateSourceText(false)).toBe(' (state as filed)');
    expect(stateSourceText(undefined)).toBe('');
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
  it('preserves caller text literally without activating Markdown', () => {
    const document = renderAppliedFilters({
      licensee: '*Radio* `HQ` [link](https://x.test)\\path',
    });
    expect(renderedText(document)).toBe(
      'Applied filters: licensee="*Radio* `HQ` [link](https://x.test)\\\\path"',
    );
    expect(markdown.render(document)).not.toMatch(/<(?:a |em>|code>)/);
  });
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
    expect(renderedText(rendered)).toBe('Applied filters: licensee="Acme \\"Radio\\"\\r\\nCo"');
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
