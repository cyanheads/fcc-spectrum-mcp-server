/** @fileoverview Eastern listing times and calendar-date arithmetic across DST. */
import { describe, expect, it } from 'vitest';
import { easternDate, parseEasternTime, shiftDate } from '@/services/uls/eastern-time.js';

describe('Eastern wall times', () => {
  it.each([
    ['2026-01-15 08:02:36', '2026-01-15T13:02:36Z'],
    ['2026-10-20 08:02:36', '2026-10-20T12:02:36Z'],
    ['2026-03-08 01:59:59', '2026-03-08T06:59:59Z'],
    ['2026-03-08 03:00:00', '2026-03-08T07:00:00Z'],
    ['2026-11-01 00:59:59', '2026-11-01T04:59:59Z'],
    ['2026-11-01 02:00:00', '2026-11-01T07:00:00Z'],
    ['2028-02-29 12:00:00', '2028-02-29T17:00:00Z'],
  ])('resolves %s', (wall, utc) => expect(parseEasternTime(wall)).toBe(utc));

  it.each([
    '2026-11-01 01:00:00',
    '2026-11-01 01:30:00',
    '2026-11-01 01:59:59',
    '2026-03-08 02:00:00',
    '2026-03-08 02:59:59',
    '2026-02-29 08:00:00',
    '2026-04-31 08:00:00',
    '2026-10-20 24:00:00',
    '2026-13-20 08:00:00',
    '',
    '2026-10-20',
  ])('leaves %s unresolved', (wall) => expect(parseEasternTime(wall)).toBeUndefined());

  it('uses calendar dates, including an instant whose UTC date is the next Eastern day', () => {
    expect(easternDate('2026-11-02T03:59:59Z')).toBe('2026-11-01');
    expect(easternDate('2026-11-02T05:00:00Z')).toBe('2026-11-02');
    expect(shiftDate('2026-11-07', -7)).toBe('2026-10-31');
    expect(shiftDate('2026-03-14', -7)).toBe('2026-03-07');
  });
});
