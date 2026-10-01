/**
 * @fileoverview Tests for the point-in-polygon state lookup: interior points, the
 * antimeridian Aleutians, border-adjacent cities, and points outside every boundary.
 * @module tests/services/uls/state-lookup.test
 */

import { describe, expect, it } from 'vitest';
import { stateAt } from '@/services/uls/state-lookup.js';

describe('stateAt', () => {
  it.each([
    ['Seattle', 47.6062, -122.3321, 'WA'],
    ['Denver', 39.7392, -104.9903, 'CO'],
    ['Washington, DC', 38.9072, -77.0369, 'DC'],
    ['San Juan', 18.4655, -66.1057, 'PR'],
    ['Honolulu', 21.3069, -157.8583, 'HI'],
    ['Anchorage', 61.2181, -149.9003, 'AK'],
  ])('places %s in %s', (_name, lat, lon, state) => {
    expect(stateAt(lat, lon)).toBe(state);
  });

  it('keeps the Aleutians on both sides of the antimeridian in Alaska', () => {
    expect(stateAt(52.85, 173.0)).toBe('AK');
    expect(stateAt(51.5, 179)).toBe('AK');
  });

  it('separates twin cities across a state line', () => {
    expect(stateAt(46.8772, -96.7898)).toBe('ND');
    expect(stateAt(46.8738, -96.7678)).toBe('MN');
    expect(stateAt(39.0997, -94.5786)).toBe('MO');
    expect(stateAt(39.1141, -94.6275)).toBe('KS');
  });

  it.each([
    ['open Pacific', 30, -140],
    ['Guam', 13.4443, 144.7937],
    ['open Atlantic', 35, -60],
    ['null island', 0, 0],
  ])('returns null for %s', (_name, lat, lon) => {
    expect(stateAt(lat, lon)).toBeNull();
  });
});
