/**
 * @fileoverview Tests for the bundled ULS code tables: radio service, status, and USPS
 * vocabularies, the full-state-name lookup, the weekly service groups, `toEntries`, and
 * `codeLabel`.
 * @module tests/services/uls/codes.test
 */

import { describe, expect, it } from 'vitest';
import {
  ANTENNA_TYPES,
  APPLICANT_TYPES,
  codeLabel,
  DEFAULT_SERVICE_GROUPS,
  LICENSE_STATUSES,
  LOCATION_TYPES,
  OPERATOR_CLASSES,
  RADIO_SERVICES,
  SERVICE_GROUPS,
  STATE_NAME_TO_CODE,
  stateNameKey,
  toEntries,
  USPS_CODES,
  USPS_STATES,
} from '@/services/uls/codes.js';

describe('RADIO_SERVICES', () => {
  it('carries 141 two-character codes and drops the AL wildcard', () => {
    const codes = Object.keys(RADIO_SERVICES);
    expect(codes).toHaveLength(141);
    expect(codes).not.toContain('AL');
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9]{2}$/);
  });

  it('labels every code with non-empty text', () => {
    for (const label of Object.values(RADIO_SERVICES)) expect(label.trim()).not.toBe('');
  });

  it('decodes codes the fixtures rely on', () => {
    expect(RADIO_SERVICES.CD).toBe('Paging and Radiotelephone');
    expect(RADIO_SERVICES.HA).toBe('Amateur');
    expect(RADIO_SERVICES.ZQ).toBeUndefined();
  });
});

describe('small code tables', () => {
  it('cover the documented status, location, antenna, applicant, and operator codes', () => {
    expect(Object.keys(LICENSE_STATUSES).sort()).toEqual(['A', 'C', 'E', 'L', 'P', 'T', 'X']);
    expect(LOCATION_TYPES.F).toBe('Fixed');
    expect(ANTENNA_TYPES.T).toBe('Transmit Antenna');
    expect(APPLICANT_TYPES.I).toBe('Individual');
    expect(OPERATOR_CLASSES.E).toBe('Amateur Extra');
  });
});

describe('USPS_CODES', () => {
  it('lists 56 codes: 50 states, DC, and five territories', () => {
    expect(USPS_CODES).toHaveLength(56);
    expect(new Set(USPS_CODES).size).toBe(56);
    expect(USPS_CODES).toEqual(Object.keys(USPS_STATES));
    for (const code of ['DC', 'PR', 'GU', 'VI', 'AS', 'MP']) expect(USPS_CODES).toContain(code);
  });
});

describe('stateNameKey', () => {
  it('lowercases, drops periods and commas, and collapses whitespace', () => {
    expect(stateNameKey('  Washington,  D.C. ')).toBe('washington dc');
    expect(stateNameKey('U.S. Virgin Islands')).toBe('us virgin islands');
  });
});

describe('STATE_NAME_TO_CODE', () => {
  it('maps every full name, by its key, back to its code', () => {
    for (const [code, name] of Object.entries(USPS_STATES)) {
      expect(STATE_NAME_TO_CODE.get(stateNameKey(name))).toBe(code);
    }
  });

  it('adds the Virgin Islands and Washington DC aliases', () => {
    expect(STATE_NAME_TO_CODE.get('virgin islands')).toBe('VI');
    expect(STATE_NAME_TO_CODE.get('us virgin islands')).toBe('VI');
    expect(STATE_NAME_TO_CODE.get('united states virgin islands')).toBe('VI');
    expect(STATE_NAME_TO_CODE.get('washington dc')).toBe('DC');
    expect(STATE_NAME_TO_CODE.get(stateNameKey('Washington, D.C.'))).toBe('DC');
  });

  it('does not conflate Washington state with the district', () => {
    expect(STATE_NAME_TO_CODE.get('washington')).toBe('WA');
  });

  it('has no entry for an unknown name', () => {
    expect(STATE_NAME_TO_CODE.get('atlantis')).toBeUndefined();
  });
});

describe('SERVICE_GROUPS', () => {
  it('names the 13 weekly groups and excludes frc', () => {
    expect(SERVICE_GROUPS).toHaveLength(13);
    expect(new Set(SERVICE_GROUPS).size).toBe(13);
    expect(SERVICE_GROUPS as readonly string[]).not.toContain('frc');
  });

  it('keeps the FCC spelling of mixed-case groups', () => {
    expect(SERVICE_GROUPS).toEqual(expect.arrayContaining(['LMpriv', 'LMcomm', 'LMbcast']));
  });

  it('draws the 10 default groups from the full set', () => {
    expect(DEFAULT_SERVICE_GROUPS).toHaveLength(10);
    for (const group of DEFAULT_SERVICE_GROUPS) expect(SERVICE_GROUPS).toContain(group);
    for (const group of ['gmrs', 'ship', 'aircr'] as const) {
      expect(DEFAULT_SERVICE_GROUPS).not.toContain(group);
    }
  });
});

describe('toEntries', () => {
  it('returns { code, label } pairs sorted by code', () => {
    const entries = toEntries({ ZA: 'last', AA: 'first', MM: 'middle' });
    expect(entries).toEqual([
      { code: 'AA', label: 'first' },
      { code: 'MM', label: 'middle' },
      { code: 'ZA', label: 'last' },
    ]);
  });

  it('sorts a real table and keeps every row', () => {
    const entries = toEntries(RADIO_SERVICES);
    expect(entries).toHaveLength(141);
    const codes = entries.map((entry) => entry.code);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
    expect(entries.find((entry) => entry.code === 'CD')?.label).toBe('Paging and Radiotelephone');
  });

  it('returns an empty list for an empty table', () => {
    expect(toEntries({})).toEqual([]);
  });
});

describe('codeLabel', () => {
  it('returns the label of a code the table holds', () => {
    expect(codeLabel(LOCATION_TYPES, 'F')).toBe('Fixed');
    expect(codeLabel(OPERATOR_CLASSES, 'E')).toBe('Amateur Extra');
    expect(codeLabel(RADIO_SERVICES, 'ZQ')).toBeUndefined();
  });

  it('has no label for a code named like an object member', () => {
    for (const code of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(codeLabel(RADIO_SERVICES, code)).toBeUndefined();
      expect(codeLabel(LICENSE_STATUSES, code)).toBeUndefined();
      expect(codeLabel(LOCATION_TYPES, code)).toBeUndefined();
      expect(codeLabel(OPERATOR_CLASSES, code)).toBeUndefined();
    }
  });
});
