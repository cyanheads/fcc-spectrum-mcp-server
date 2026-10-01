/**
 * @fileoverview Tests for the shared tool-input schemas: each normalization runs before
 * the pattern check, blank strings read as unset, and malformed values are rejected.
 * @module tests/tools/input-schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  callsignSchema,
  cursorSchema,
  frequencySchema,
  frnSchema,
  latitudeSchema,
  licenseStatusSchema,
  liveStatusSchema,
  longitudeSchema,
  radioServiceSchema,
  stateSchema,
  unitSchema,
  usiSchema,
} from '@/mcp-server/tools/input-schemas.js';

/** Parse and return the value, or `undefined` for a rejection. */
function accepted(schema: z.ZodType, value: unknown): unknown {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

describe('callsignSchema', () => {
  it('trims, uppercases, drops spaces, and removes one portable suffix', () => {
    expect(accepted(callsignSchema, 'n0call/4')).toBe('N0CALL');
    expect(accepted(callsignSchema, '  kab 123 ')).toBe('KAB123');
    expect(accepted(callsignSchema, 'L000012345')).toBe('L000012345');
  });

  it('rejects a prefix form, a too-short value, wildcards, and non-strings', () => {
    expect(callsignSchema.safeParse('VE3/N0CALL').success).toBe(false);
    expect(callsignSchema.safeParse('AB').success).toBe(false);
    expect(callsignSchema.safeParse('*').success).toBe(false);
    expect(callsignSchema.safeParse('N0CALL*').success).toBe(false);
    expect(callsignSchema.safeParse('ABCDEFGHIJK').success).toBe(false);
    expect(callsignSchema.safeParse(12345).success).toBe(false);
  });
});

describe('frnSchema', () => {
  it('strips separators and left-pads to ten digits', () => {
    expect(accepted(frnSchema, '123-4567')).toBe('0001234567');
    expect(accepted(frnSchema, ' 12 345 ')).toBe('0000012345');
    expect(accepted(frnSchema, '0001234567')).toBe('0001234567');
  });

  it('rejects more than ten digits and non-digits', () => {
    expect(frnSchema.safeParse('12345678901').success).toBe(false);
    expect(frnSchema.safeParse('12AB').success).toBe(false);
    expect(frnSchema.safeParse('').success).toBe(false);
  });
});

describe('usiSchema', () => {
  it('accepts a decimal string without leading zeros', () => {
    expect(accepted(usiSchema, '1001')).toBe('1001');
    expect(accepted(usiSchema, ' 42 ')).toBe('42');
    expect(accepted(usiSchema, '9999999999')).toBe('9999999999');
  });

  it('rejects zero, leading zeros, and over ten digits', () => {
    expect(usiSchema.safeParse('0').success).toBe(false);
    expect(usiSchema.safeParse('007').success).toBe(false);
    expect(usiSchema.safeParse('12345678901').success).toBe(false);
    expect(usiSchema.safeParse('-5').success).toBe(false);
    expect(usiSchema.safeParse(1001).success).toBe(false);
  });
});

describe('stateSchema', () => {
  it('uppercases codes and maps full names', () => {
    expect(accepted(stateSchema, 'wa')).toBe('WA');
    expect(accepted(stateSchema, 'Washington, D.C.')).toBe('DC');
    expect(accepted(stateSchema, 'north dakota')).toBe('ND');
    expect(accepted(stateSchema, 'Virgin Islands')).toBe('VI');
  });

  it('rejects unknown names and codes', () => {
    expect(stateSchema.safeParse('Atlantis').success).toBe(false);
    expect(stateSchema.safeParse('ZZ').success).toBe(false);
    expect(stateSchema.safeParse('').success).toBe(false);
  });
});

describe('radioServiceSchema', () => {
  it('trims and uppercases', () => {
    expect(accepted(radioServiceSchema, ' cd ')).toBe('CD');
    expect(accepted(radioServiceSchema, 'q9')).toBe('Q9');
  });

  it('rejects anything but two alphanumerics', () => {
    expect(radioServiceSchema.safeParse('C').success).toBe(false);
    expect(radioServiceSchema.safeParse('CDX').success).toBe(false);
    expect(radioServiceSchema.safeParse('C-').success).toBe(false);
  });
});

describe('licenseStatusSchema and liveStatusSchema', () => {
  it('normalize case and keep any lowercase', () => {
    expect(accepted(licenseStatusSchema, 'ANY')).toBe('any');
    expect(accepted(licenseStatusSchema, ' c ')).toBe('C');
    expect(accepted(liveStatusSchema, 'Any')).toBe('any');
    expect(accepted(liveStatusSchema, 'x')).toBe('X');
  });

  it('licenseStatusSchema accepts every status and rejects unknown ones', () => {
    for (const status of ['A', 'C', 'E', 'L', 'P', 'T', 'X']) {
      expect(accepted(licenseStatusSchema, status)).toBe(status);
    }
    expect(licenseStatusSchema.safeParse('Z').success).toBe(false);
  });

  it('liveStatusSchema rejects the non-live statuses', () => {
    for (const status of ['C', 'E', 'P', 'T']) {
      expect(liveStatusSchema.safeParse(status).success).toBe(false);
    }
  });
});

describe('unitSchema', () => {
  it('maps any casing to the canonical spelling', () => {
    expect(accepted(unitSchema, 'mhz')).toBe('MHz');
    expect(accepted(unitSchema, ' KHZ ')).toBe('kHz');
    expect(accepted(unitSchema, 'ghz')).toBe('GHz');
  });

  it('rejects an unknown unit', () => {
    expect(unitSchema.safeParse('hz').success).toBe(false);
  });
});

describe('frequencySchema', () => {
  it('requires a positive number', () => {
    expect(frequencySchema.safeParse(152.24).success).toBe(true);
    expect(frequencySchema.safeParse(0).success).toBe(false);
    expect(frequencySchema.safeParse(-1).success).toBe(false);
    expect(frequencySchema.safeParse('152').success).toBe(false);
  });
});

describe('latitudeSchema and longitudeSchema', () => {
  it('accept numbers, decimal strings, and DMS strings', () => {
    expect(accepted(latitudeSchema, 47.6)).toBe(47.6);
    expect(accepted(latitudeSchema, '47.6')).toBe(47.6);
    expect(accepted(latitudeSchema, '47-37-13.8N')).toBeCloseTo(47.6205, 5);
    expect(accepted(longitudeSchema, '122°20\'57.5"W')).toBeCloseTo(-122.349306, 5);
    expect(accepted(longitudeSchema, '122 20 57.5 W')).toBeCloseTo(-122.349306, 5);
    expect(accepted(latitudeSchema, '33-0-0S')).toBe(-33);
  });

  it('reject values past the bounds', () => {
    expect(latitudeSchema.safeParse(91).success).toBe(false);
    expect(latitudeSchema.safeParse(-90.5).success).toBe(false);
    expect(longitudeSchema.safeParse(181).success).toBe(false);
    expect(latitudeSchema.safeParse('91').success).toBe(false);
  });

  it('reject DMS without a hemisphere, with the wrong hemisphere, or with minutes over 59', () => {
    expect(latitudeSchema.safeParse('47-37-13.8').success).toBe(false);
    expect(latitudeSchema.safeParse('47-37-13.8E').success).toBe(false);
    expect(longitudeSchema.safeParse('122-20-57.5N').success).toBe(false);
    expect(latitudeSchema.safeParse('47-61-00N').success).toBe(false);
    expect(latitudeSchema.safeParse('north').success).toBe(false);
  });
});

describe('cursorSchema', () => {
  it('reads a blank or whitespace-only cursor as unset', () => {
    expect(cursorSchema.safeParse('').data).toBeUndefined();
    expect(cursorSchema.safeParse('   ').data).toBeUndefined();
    expect(cursorSchema.safeParse('').success).toBe(true);
    expect(cursorSchema.safeParse(undefined).success).toBe(true);
  });

  it('accepts a url-safe token of up to 200 characters', () => {
    expect(accepted(cursorSchema, 'abc_DEF-123')).toBe('abc_DEF-123');
    expect(cursorSchema.safeParse('a'.repeat(200)).success).toBe(true);
  });

  it('rejects embedded spaces, other characters, and tokens over 200 characters', () => {
    expect(cursorSchema.safeParse('has space').success).toBe(false);
    expect(cursorSchema.safeParse(' abc ').success).toBe(false);
    expect(cursorSchema.safeParse('a+b').success).toBe(false);
    expect(cursorSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });
});

describe('blankAsUnset', () => {
  const schema = z.object({ state: blankAsUnset(stateSchema.optional()) });

  it('turns blank and whitespace-only strings into a missing field', () => {
    expect(schema.parse({ state: '' })).toEqual({ state: undefined });
    expect(schema.parse({ state: '  \t ' })).toEqual({ state: undefined });
    expect(schema.parse({})).toEqual({ state: undefined });
  });

  it('passes a real value through the inner schema', () => {
    expect(schema.parse({ state: 'wa' })).toEqual({ state: 'WA' });
    expect(schema.safeParse({ state: 'Atlantis' }).success).toBe(false);
  });

  it('leaves non-string values to the inner schema', () => {
    expect(schema.safeParse({ state: 5 }).success).toBe(false);
    expect(blankAsUnset(z.number()).safeParse(0).data).toBe(0);
  });

  it('still requires a value when the inner schema is not optional', () => {
    expect(blankAsUnset(z.string()).safeParse('  ').success).toBe(false);
  });
});
