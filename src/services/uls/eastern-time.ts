/**
 * @fileoverview FCC listing wall times and rotation dates in America/New_York, including
 * ambiguous and nonexistent DST times. Invalid wall times remain unresolved for HEAD.
 * @module services/uls/eastern-time
 */

const eastern = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const DAY_MS = 86_400_000;

/** The Eastern calendar date of a UTC instant; never derives it from a filename suffix. */
export function easternDate(iso: string): string {
  return eastern.format(new Date(iso)).slice(0, 10);
}

/** Shift an ISO calendar date by whole calendar days, independent of DST day lengths. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Resolve a wall time only when exactly one UTC instant round-trips through the zone. */
export function parseEasternTime(wall: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(wall)) return;
  const naive = Date.parse(`${wall.replace(' ', 'T')}Z`);
  if (
    !Number.isFinite(naive) ||
    new Date(naive).toISOString().slice(0, 19).replace('T', ' ') !== wall
  )
    return;
  const offsets = new Set<number>();
  for (const delta of [-36, 36]) {
    const sample = naive + delta * 3_600_000;
    const local = eastern.format(new Date(sample));
    offsets.add(Date.parse(`${local.replace(' ', 'T')}Z`) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((instant) => eastern.format(new Date(instant)) === wall);
  const [candidate] = candidates;
  if (candidates.length === 1 && candidate !== undefined)
    return new Date(candidate).toISOString().replace('.000Z', 'Z');
  return undefined;
}
