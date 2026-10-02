/**
 * @fileoverview Tests for the bundled FCC market-area table (`data/market-states.json`) and its
 * loader: the table's shape and coverage of each market family, the FCC citation lines it
 * carries, the rule-derived families (IVM, AMT, SLC), the Gulf of Mexico areas listed with no
 * state, and the state → codes and state → FIPS prefix lookups the market state filter reads.
 * @module tests/services/uls/market-states.test
 */

import { describe, expect, it } from 'vitest';
import { USPS_CODES } from '@/services/uls/codes.js';
import table from '@/services/uls/data/market-states.json' with { type: 'json' };
import {
  countyFipsPrefix,
  marketCodesIn,
  STATELESS_MARKET_CODES,
} from '@/services/uls/market-states.js';

const markets: Record<string, string[]> = table.markets;
const family = (prefix: string) => Object.keys(markets).filter((code) => code.startsWith(prefix));

describe('market-states.json', () => {
  it('keys every market by a three-letter, three-digit code with sorted, distinct USPS states', () => {
    for (const [code, states] of Object.entries(markets)) {
      expect(code).toMatch(/^[A-Z]{3}\d{3}$/);
      expect(states, code).toEqual([...new Set(states)].sort());
      for (const state of states) expect(USPS_CODES, code).toContain(state);
    }
  });

  it.each([
    ['AMT', 10],
    ['BEA', 176],
    ['BTA', 495],
    ['CMA', 734],
    ['EAG', 12],
    ['IVM', 734],
    ['MEA', 52],
    ['MTA', 51],
    ['PEA', 416],
    ['REA', 12],
    ['RPC', 5],
    ['SLC', 56],
    ['VPC', 42],
  ])('covers every %s area (%i)', (prefix, count) => {
    expect(family(prefix)).toHaveLength(count);
  });

  it('lists the Gulf of Mexico areas, and only them, with no state', () => {
    expect(Object.keys(markets).filter((code) => markets[code]?.length === 0)).toEqual([
      'BEA176',
      'BTA494',
      'BTA495',
      'CMA306',
      'IVM306',
      'MEA052',
      'PEA416',
      'REA012',
    ]);
  });

  it('lists a market spanning several states under each, from the FCC county assignments', () => {
    expect(markets.BEA010).toEqual(['CT', 'MA', 'NJ', 'NY', 'PA', 'VT']);
    expect(markets.MTA010).toEqual(['DC', 'MD', 'PA', 'VA', 'WV']);
    expect(markets.CMA693).toEqual(['WA']);
    expect(markets.BTA138).toEqual(['MN', 'ND']);
    expect(markets.PEA001).toEqual(['CT', 'NJ', 'NY', 'PA']);
  });

  it('derives IVM from the CMA numbering, AMT from its EAs, and SLC from alphabetical USPS order', () => {
    for (const code of family('CMA')) {
      expect(markets[code.replace('CMA', 'IVM')], code).toEqual(markets[code]);
    }
    expect(markets.AMT008).toEqual(['HI']);
    expect(markets.AMT009).toEqual(['AK']);
    expect(markets.AMT006).toEqual(['AZ', 'CA', 'OR']);
    // PW (Palau) holds position 44 and is not a state the filter takes.
    expect([
      markets.SLC001,
      markets.SLC043,
      markets.SLC044,
      markets.SLC045,
      markets.SLC057,
    ]).toEqual([['AK'], ['PR'], undefined, ['RI'], ['WY']]);
  });

  it('maps each FIPS state prefix to its USPS code, every state and territory once', () => {
    expect(Object.values(table.fipsStates).sort()).toEqual([...USPS_CODES].sort());
    expect(table.fipsStates).toMatchObject({ '02': 'AK', '11': 'DC', '53': 'WA', '72': 'PR' });
  });

  it("carries the FCC's citation lines for the Rand McNally BTA and MTA definitions", () => {
    expect(table.source).toContain(
      'Basic Trading Areas delineated by the Rand McNally 1992 Commercial Atlas & Marketing Guide, 123rd Edition, at pages 38-39; extended and revised by the Federal Communications Commission, 59 FR 46195 (September 7, 1994)',
    );
    expect(table.source).toContain(
      'Major Trading Areas delineated by the Rand McNally 1992 Commercial Atlas & Marketing Guide, 123rd Edition, at pages 38-39, extended and excepted by the Federal Communications Commission, 59 FR 14115 (March 25, 1994)',
    );
  });
});

describe('market-states loader', () => {
  it('lists the codes whose area reaches a state, a multi-state market under each', () => {
    expect(marketCodesIn('WA')).toContain('CMA693');
    expect(marketCodesIn('WA')).not.toContain('MTA010');
    for (const state of ['DC', 'MD', 'PA', 'VA', 'WV']) {
      expect(marketCodesIn(state), state).toContain('MTA010');
    }
  });

  it('gives every USPS state and territory codes and a FIPS prefix', () => {
    for (const state of USPS_CODES) {
      expect(marketCodesIn(state).length, state).toBeGreaterThan(0);
      expect(countyFipsPrefix(state), state).toMatch(/^\d{2}$/);
    }
    expect(countyFipsPrefix('AK')).toBe('02');
  });

  it('answers nothing for a code that is not a state', () => {
    expect(marketCodesIn('PW')).toEqual([]);
    expect(countyFipsPrefix('PW')).toBeUndefined();
  });

  it('names the Gulf of Mexico areas as the codes that match no state', () => {
    expect([...STATELESS_MARKET_CODES].sort()).toEqual([
      'BEA176',
      'BTA494',
      'BTA495',
      'CMA306',
      'IVM306',
      'MEA052',
      'PEA416',
      'REA012',
    ]);
  });
});
