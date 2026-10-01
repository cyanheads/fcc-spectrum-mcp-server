/**
 * @fileoverview Tests for the pure normalizers: DMS conversion, coordinate text, callsign,
 * FRN, state, status, and unit spellings, frequency conversion, and band resolution.
 * @module tests/services/uls/normalize.test
 */

import { describe, expect, it } from 'vitest';
import {
  dmsToDecimal,
  MAX_FREQUENCY_MHZ,
  normalizeCallsign,
  normalizeFrn,
  normalizeStateInput,
  normalizeStatusInput,
  normalizeUnitInput,
  parseCoordinateText,
  resolveBand,
  toMhz,
} from '@/services/uls/normalize.js';

describe('dmsToDecimal', () => {
  it('converts degrees, minutes, and seconds with the hemisphere sign', () => {
    expect(dmsToDecimal(47, 37, 13.8, 'N', 'latitude')).toBeCloseTo(47.6205, 5);
    expect(dmsToDecimal(122, 20, 57.5, 'W', 'longitude')).toBeCloseTo(-122.349306, 5);
    expect(dmsToDecimal(33, 0, 0, 's', 'latitude')).toBe(-33);
    expect(dmsToDecimal(10, 30, 0, 'E', 'longitude')).toBe(10.5);
  });

  it('accepts the exact axis bounds and rejects anything past them', () => {
    expect(dmsToDecimal(90, 0, 0, 'N', 'latitude')).toBe(90);
    expect(dmsToDecimal(180, 0, 0, 'W', 'longitude')).toBe(-180);
    expect(dmsToDecimal(90, 0, 0.1, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(180, 0, 1, 'E', 'longitude')).toBeNull();
  });

  it('returns null when any part is missing', () => {
    expect(dmsToDecimal(null, 1, 2, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(1, null, 2, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(1, 2, null, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(1, 2, 3, null, 'latitude')).toBeNull();
  });

  it('rejects minutes or seconds at or above 60, negatives, and the wrong hemisphere', () => {
    expect(dmsToDecimal(47, 60, 0, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(47, 0, 60, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(-47, 0, 0, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(47, -1, 0, 'N', 'latitude')).toBeNull();
    expect(dmsToDecimal(47, 0, 0, 'E', 'latitude')).toBeNull();
    expect(dmsToDecimal(47, 0, 0, 'N', 'longitude')).toBeNull();
    expect(dmsToDecimal(47, 0, 0, 'Q', 'latitude')).toBeNull();
  });
});

describe('parseCoordinateText', () => {
  it('parses decimal text, signed and unsigned', () => {
    expect(parseCoordinateText('47.62', 'latitude')).toBe(47.62);
    expect(parseCoordinateText(' -122.5 ', 'longitude')).toBe(-122.5);
    expect(parseCoordinateText('+10', 'latitude')).toBe(10);
    expect(parseCoordinateText('.5', 'latitude')).toBe(0.5);
  });

  it('parses the three DMS spellings', () => {
    const expected = 47 + 37 / 60 + 13.8 / 3600;
    expect(parseCoordinateText('47-37-13.8N', 'latitude')).toBeCloseTo(expected, 9);
    expect(parseCoordinateText('47 37 13.8 N', 'latitude')).toBeCloseTo(expected, 9);
    expect(parseCoordinateText('47°37\'13.8"N', 'latitude')).toBeCloseTo(expected, 9);
    expect(parseCoordinateText('122-20-57.5 w', 'longitude')).toBeCloseTo(
      -(122 + 20 / 60 + 57.5 / 3600),
      9,
    );
  });

  it('returns undefined for text that is neither form or fails the DMS rule', () => {
    expect(parseCoordinateText('north', 'latitude')).toBeUndefined();
    expect(parseCoordinateText('47-37-13.8', 'latitude')).toBeUndefined();
    expect(parseCoordinateText('47-61-00N', 'latitude')).toBeUndefined();
    expect(parseCoordinateText('47-37-60N', 'latitude')).toBeUndefined();
    expect(parseCoordinateText('47-37-13.8E', 'latitude')).toBeUndefined();
    expect(parseCoordinateText('', 'latitude')).toBeUndefined();
  });

  it('leaves the numeric bound check to the schema for decimal text', () => {
    expect(parseCoordinateText('91', 'latitude')).toBe(91);
  });
});

describe('normalizeCallsign', () => {
  it('trims, uppercases, drops internal spaces, and strips one portable suffix', () => {
    expect(normalizeCallsign(' n0call/4 ')).toBe('N0CALL');
    expect(normalizeCallsign('k z z 901')).toBe('KZZ901');
    expect(normalizeCallsign('KZZ901/QRP')).toBe('KZZ901');
    expect(normalizeCallsign('L000000123')).toBe('L000000123');
  });

  it('keeps prefix-portable forms and long suffixes for the pattern to reject', () => {
    expect(normalizeCallsign('VE3/N0CALL')).toBe('VE3/N0CALL');
    expect(normalizeCallsign('N0CALL/MOBILE')).toBe('N0CALL/MOBILE');
  });
});

describe('normalizeFrn', () => {
  it('strips spaces and hyphens and left-pads to ten digits', () => {
    expect(normalizeFrn('1234567')).toBe('0001234567');
    expect(normalizeFrn('000-123 4567')).toBe('0001234567');
    expect(normalizeFrn('0012345678')).toBe('0012345678');
  });

  it('passes over-long and non-digit values through unpadded', () => {
    expect(normalizeFrn('12345678901')).toBe('12345678901');
    expect(normalizeFrn('A123')).toBe('A123');
  });
});

describe('normalizeStateInput', () => {
  it('uppercases two-letter codes', () => {
    expect(normalizeStateInput(' wa ')).toBe('WA');
    expect(normalizeStateInput('xx')).toBe('XX');
  });

  it('maps full names, punctuation and case aside', () => {
    expect(normalizeStateInput('Washington')).toBe('WA');
    expect(normalizeStateInput('  north   dakota ')).toBe('ND');
    expect(normalizeStateInput('District of Columbia')).toBe('DC');
    expect(normalizeStateInput('Washington, D.C.')).toBe('DC');
    expect(normalizeStateInput('U.S. Virgin Islands')).toBe('VI');
    expect(normalizeStateInput('virgin islands')).toBe('VI');
    expect(normalizeStateInput('Puerto Rico')).toBe('PR');
  });

  it('returns unknown names trimmed for the enum to reject', () => {
    expect(normalizeStateInput(' Atlantis ')).toBe('Atlantis');
  });
});

describe('normalizeStatusInput / normalizeUnitInput', () => {
  it('uppercases status codes and keeps "any" lowercase', () => {
    expect(normalizeStatusInput(' a ')).toBe('A');
    expect(normalizeStatusInput('ANY')).toBe('any');
    expect(normalizeStatusInput('Any')).toBe('any');
  });

  it('maps any casing of a unit to its canonical spelling', () => {
    expect(normalizeUnitInput('mhz')).toBe('MHz');
    expect(normalizeUnitInput(' GHZ ')).toBe('GHz');
    expect(normalizeUnitInput('KHz')).toBe('kHz');
    expect(normalizeUnitInput('hz')).toBe('hz');
  });
});

describe('toMhz / resolveBand', () => {
  it('converts kHz and GHz to MHz', () => {
    expect(toMhz(152_240, 'kHz')).toBeCloseTo(152.24, 9);
    expect(toMhz(2.5, 'GHz')).toBe(2500);
    expect(toMhz(462.5625, 'MHz')).toBe(462.5625);
  });

  it('returns undefined when neither edge is given', () => {
    expect(resolveBand(undefined, undefined, 'MHz')).toBeUndefined();
  });

  it('treats a lone low edge as a single frequency', () => {
    expect(resolveBand(152.24, undefined, 'MHz')).toEqual({
      ok: true,
      lowMhz: 152.24,
      highMhz: 152.24,
    });
  });

  it('converts both edges in the given unit', () => {
    expect(resolveBand(2.496, 2.69, 'GHz')).toEqual({ ok: true, lowMhz: 2496, highMhz: 2690 });
  });

  it('names each invalid band', () => {
    expect(resolveBand(undefined, 10, 'MHz')).toEqual({ ok: false, reason: 'high_without_low' });
    expect(resolveBand(20, 10, 'MHz')).toEqual({ ok: false, reason: 'high_below_low' });
    expect(resolveBand(1, 301, 'GHz')).toEqual({ ok: false, reason: 'above_max' });
    expect(resolveBand(MAX_FREQUENCY_MHZ + 1, undefined, 'MHz')).toEqual({
      ok: false,
      reason: 'above_max',
    });
  });

  it('accepts the 300 GHz ceiling exactly', () => {
    expect(resolveBand(300, undefined, 'GHz')).toEqual({
      ok: true,
      lowMhz: MAX_FREQUENCY_MHZ,
      highMhz: MAX_FREQUENCY_MHZ,
    });
  });
});
