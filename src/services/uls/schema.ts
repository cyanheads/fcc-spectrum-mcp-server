/**
 * @fileoverview The ULS index store spec shared by the ingester (writer) and the index
 * service (reader): the `licenses` primary table with its FTS5 licensee-name index,
 * the auxiliary tables created by migration, generation file naming, and the
 * `current.json` pointer that names the published generation.
 * @module services/uls/schema
 */

import { randomUUID } from 'node:crypto';
import { link, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpError, serializationError } from '@cyanheads/mcp-ts-core/errors';
import {
  type MirrorStore,
  type SqliteHandle,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';

/** Mirror name for logs and telemetry. */
export const MIRROR_NAME = 'fcc-uls';

/** Current store schema version; bump it and add a migration on any schema change. */
const SCHEMA_VERSION = 4;

/** License statuses whose records keep sites, antennas, frequencies, and market blocks. */
export const LIVE_STATUSES = ['A', 'L', 'X'] as const;

/** A live license status. */
export type LiveStatus = (typeof LIVE_STATUSES)[number];

/** A spectrum leasing arrangement's callsign: `L` followed by nine digits. */
export const LEASE_CALLSIGN = /^L\d{9}$/;

/** Radio services where a blank applicant type counts as an individual (amateur, GMRS). */
export const INDIVIDUAL_BY_DEFAULT_SERVICES = ['HA', 'HV', 'ZA'] as const;

/**
 * Columns of the `licenses` primary table. `usi INTEGER PRIMARY KEY` makes the USI the
 * rowid alias, so `licenses_fts.rowid = licenses.usi`. HD/EN/AM/MK fields plus the
 * derived `market_states` (`,ND,MN,`), `service_group`, `is_individual`, and `is_lease`.
 */
export const LICENSE_COLUMNS = {
  usi: 'INTEGER',
  callsign: 'TEXT',
  license_status: 'TEXT',
  radio_service_code: 'TEXT',
  grant_date: 'TEXT',
  expired_date: 'TEXT',
  cancellation_date: 'TEXT',
  effective_date: 'TEXT',
  last_action_date: 'TEXT',
  licensee_name: 'TEXT',
  licensee_city: 'TEXT',
  licensee_state: 'TEXT',
  frn: 'TEXT',
  applicant_type: 'TEXT',
  operator_class: 'TEXT',
  trustee_callsign: 'TEXT',
  previous_callsign: 'TEXT',
  trustee_name: 'TEXT',
  market_code: 'TEXT',
  channel_block: 'TEXT',
  market_name: 'TEXT',
  market_states: 'TEXT',
  service_group: 'TEXT',
  is_individual: 'INTEGER NOT NULL DEFAULT 0',
  is_lease: 'INTEGER NOT NULL DEFAULT 0',
} as const;

/**
 * Auxiliary tables and their indexes. Keys of the upstream-data tables are indexed but
 * not enforced: a duplicate line in a snapshot must not abort a whole step. The
 * bookkeeping tables (`service_codes`, `ingest_files`, `meta`) do enforce theirs. A license
 * can file several sites under one location number; `site_seq` numbers them in filing order.
 */
const AUX_DDL = `
CREATE TABLE IF NOT EXISTS lease_links (
  lease_usi INTEGER NOT NULL,
  parent_usi INTEGER NOT NULL,
  parent_callsign TEXT,
  lease_id TEXT
);
CREATE INDEX IF NOT EXISTS lease_links_lease ON lease_links (lease_usi);
CREATE INDEX IF NOT EXISTS lease_links_parent ON lease_links (parent_usi);

CREATE TABLE IF NOT EXISTS locations (
  usi INTEGER NOT NULL,
  location_number INTEGER NOT NULL,
  site_seq INTEGER NOT NULL DEFAULT 1,
  location_type TEXT,
  location_class TEXT,
  address TEXT,
  city TEXT,
  county TEXT,
  state TEXT,
  radius_km REAL,
  ground_elevation_m REAL,
  lat REAL,
  lon REAL,
  coord_dms TEXT,
  asr_number TEXT,
  support_height_m REAL,
  overall_height_m REAL,
  structure_type TEXT,
  location_name TEXT,
  site_state TEXT,
  state_derived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS locations_key ON locations (usi, location_number);
CREATE INDEX IF NOT EXISTS locations_coords ON locations (lat, lon);
CREATE INDEX IF NOT EXISTS locations_site_state ON locations (site_state);

CREATE TABLE IF NOT EXISTS antennas (
  usi INTEGER NOT NULL,
  location_number INTEGER NOT NULL,
  antenna_number INTEGER NOT NULL,
  antenna_type TEXT,
  height_to_tip_m REAL,
  height_to_center_m REAL,
  make TEXT,
  model TEXT,
  polarization TEXT,
  beamwidth_deg REAL,
  gain_dbi REAL,
  azimuth_deg REAL,
  haat_m REAL
);
CREATE INDEX IF NOT EXISTS antennas_key ON antennas (usi, location_number, antenna_number);

CREATE TABLE IF NOT EXISTS frequencies (
  usi INTEGER NOT NULL,
  location_number INTEGER NOT NULL,
  antenna_number INTEGER NOT NULL,
  freq_seq_id INTEGER NOT NULL,
  class_station TEXT,
  frequency_mhz REAL,
  upper_mhz REAL,
  power_output_w REAL,
  erp_w REAL,
  eirp_dbm REAL,
  transmitter_make TEXT,
  transmitter_model TEXT,
  emissions TEXT,
  bandwidth_mhz REAL,
  occ_low REAL,
  occ_high REAL,
  band_class INTEGER
);
CREATE INDEX IF NOT EXISTS frequencies_key ON frequencies (usi, location_number);
CREATE INDEX IF NOT EXISTS frequencies_band ON frequencies (band_class, occ_low);

CREATE TABLE IF NOT EXISTS market_blocks (
  usi INTEGER NOT NULL,
  partition_area_id INTEGER NOT NULL,
  lower REAL NOT NULL,
  upper REAL,
  band_class INTEGER
);
CREATE INDEX IF NOT EXISTS market_blocks_usi ON market_blocks (usi);
CREATE INDEX IF NOT EXISTS market_blocks_band ON market_blocks (band_class, lower);

CREATE TABLE IF NOT EXISTS service_codes (
  code TEXT PRIMARY KEY NOT NULL,
  service_group TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingest_files (
  path TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  service_group TEXT,
  last_modified TEXT NOT NULL,
  counts_created TEXT NOT NULL,
  size_bytes INTEGER,
  stage TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  stats_json TEXT NOT NULL DEFAULT '{}',
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

/** Keys of the `meta` table. */
export const META_KEYS = {
  /** Widest occupied band among site frequency rows, in MHz — bounds the open band class's scan. */
  maxSiteBand: 'max_site_band_mhz',
  /** Widest market block, in MHz — bounds the open band class's scan of `market_blocks`. */
  maxMarketBand: 'max_market_band_mhz',
  /** Per-group record, site, and frequency counts, as JSON. */
  groupStats: 'group_stats',
  /**
   * Present when the generation was built by an earlier schema whose derived values cannot be
   * recomputed in place; such a generation is never served or refreshed, only replaced.
   */
  rebuildRequired: 'rebuild_required',
} as const;

/** Per-group counts kept in `meta` under {@link META_KEYS.groupStats}. */
export type GroupStats = Record<string, { frequencies: number; records: number; sites: number }>;

/**
 * Progress of one applied file: the `ingest_files.stage` values, in step order. A daily file
 * is written once, as `complete`.
 */
export type IngestStage = 'downloaded' | 'records' | 'complete';

/** Per-record-type line statistics kept in `ingest_files.stats_json`. */
export type RecordStats = Record<
  string,
  { kept: number; read: number; rejected: number; orphaned?: number }
>;

/** Lowest band class: occupied widths up to 2^-14 MHz (about 61 Hz), zero included. */
const MIN_BAND_CLASS = -14;

/** Highest power-of-two band class (8,192 MHz); a wider band falls in the open class above it. */
const MAX_BAND_CLASS = 13;

/**
 * SQL for the band class of an occupied width in MHz, `NULL` for `NULL`: the smallest `c` from
 * {@link MIN_BAND_CLASS} to {@link MAX_BAND_CLASS} with `width ≤ 2^c`, else the open class
 * `MAX_BAND_CLASS + 1`. Rows are indexed on `(band_class, lower edge)`, so an overlap lookup
 * scans each class from the query's low edge minus that class's widest band
 * ({@link bandClassBounds}), and a narrow lookup never pays for a wide filing. A CASE ladder
 * rather than `log2()`, which is a compile-time option of SQLite.
 */
export function bandClassSql(width: string): string {
  const steps: string[] = [];
  for (let c = MIN_BAND_CLASS; c <= MAX_BAND_CLASS; c++) {
    steps.push(`WHEN ${width} <= ${2 ** c} THEN ${c}`);
  }
  return `CASE ${steps.join(' ')} WHEN ${width} IS NOT NULL THEN ${MAX_BAND_CLASS + 1} END`;
}

/**
 * Every band class with the widest occupied band it can hold: a power-of-two class its
 * ceiling, and the open class `widest`, the table's stored widest band (kept in `meta`).
 */
export function bandClassBounds(widest: number): [bandClass: number, bound: number][] {
  const bounds: [number, number][] = [];
  for (let c = MIN_BAND_CLASS; c <= MAX_BAND_CLASS; c++) bounds.push([c, 2 ** c]);
  bounds.push([MAX_BAND_CLASS + 1, widest]);
  return bounds;
}

/**
 * Schema 2: add `locations.site_seq` to a schema 1 generation, numbering the sites under each
 * `(usi, location_number)` in row order, which is filing order. A database {@link AUX_DDL}
 * just created already has the column.
 */
function addSiteSeq(handle: SqliteHandle): void {
  const present = handle
    .prepare<{ n: number }>(
      "SELECT count(*) AS n FROM pragma_table_info('locations') WHERE name = 'site_seq'",
    )
    .get()?.n;
  if (present) return;
  handle.exec(
    `ALTER TABLE locations ADD COLUMN site_seq INTEGER NOT NULL DEFAULT 1;
     UPDATE locations SET site_seq = numbered.seq
     FROM (SELECT rowid AS id,
             row_number() OVER (PARTITION BY usi, location_number ORDER BY rowid) AS seq
           FROM locations) AS numbered
     WHERE locations.rowid = numbered.id AND numbered.seq > 1;`,
  );
}

/**
 * Schema 3: give a schema 2 generation's frequencies and market blocks their
 * {@link bandClassSql band class}, indexed with the lower edge in place of the lower-edge-only
 * indexes. A database {@link AUX_DDL} just created already has both.
 */
function addBandClasses(handle: SqliteHandle): void {
  const present = handle
    .prepare<{ n: number }>(
      "SELECT count(*) AS n FROM pragma_table_info('frequencies') WHERE name = 'band_class'",
    )
    .get()?.n;
  if (present) return;
  handle.exec(
    `DROP INDEX IF EXISTS frequencies_occ_low;
     DROP INDEX IF EXISTS market_blocks_lower;
     ALTER TABLE frequencies ADD COLUMN band_class INTEGER;
     UPDATE frequencies SET band_class = ${bandClassSql('occ_high - occ_low')};
     CREATE INDEX frequencies_band ON frequencies (band_class, occ_low);
     ALTER TABLE market_blocks ADD COLUMN band_class INTEGER;
     UPDATE market_blocks SET band_class = ${bandClassSql('COALESCE(upper, lower) - lower')};
     CREATE INDEX market_blocks_band ON market_blocks (band_class, lower);`,
  );
}

/**
 * Schema 4: mark a generation an earlier schema built as needing a rebuild. Schema 4 derives
 * `is_individual` from EN fields the index does not keep (the name parts) and widens no site
 * frequency past an upper edge filed below it, so an older generation's rows cannot be
 * recomputed in place. A database {@link AUX_DDL} just created holds no licenses and takes
 * no mark.
 */
function markRebuildRequired(handle: SqliteHandle): void {
  handle.exec(
    `INSERT OR REPLACE INTO meta (key, value)
       SELECT '${META_KEYS.rebuildRequired}', '4' WHERE EXISTS (SELECT 1 FROM licenses);`,
  );
}

/** True when the generation behind `handle` carries the {@link markRebuildRequired} mark. */
export function isRebuildRequired(handle: SqliteHandle): boolean {
  return Boolean(handle.prepare('SELECT 1 FROM meta WHERE key = ?').get(META_KEYS.rebuildRequired));
}

/** Create the SQLite mirror store for one generation file. Nothing opens until first use. */
export function createUlsStore(path: string): MirrorStore {
  return sqliteMirrorStore({
    path,
    table: 'licenses',
    primaryKey: 'usi',
    columns: LICENSE_COLUMNS,
    fts: ['licensee_name'],
    indexes: [
      { columns: ['callsign'] },
      { columns: ['frn'] },
      { columns: ['radio_service_code', 'license_status'] },
      { columns: ['licensee_state'] },
    ],
    version: SCHEMA_VERSION,
    migrations: [
      { version: 1, up: (handle: SqliteHandle) => handle.exec(AUX_DDL) },
      { version: 2, up: addSiteSeq },
      { version: 3, up: addBandClasses },
      { version: 4, up: markRebuildRequired },
    ],
  });
}

/** Prefix and suffix of generation file names: `fcc-uls-<stamp>.db`. */
const GENERATION_PREFIX = 'fcc-uls-';
const GENERATION_SUFFIX = '.db';

/**
 * Every name {@link generationFileName} produces from a {@link compactStamp}, and nothing
 * else: a bare file name, so a pointer can never name a path outside the mirror directory.
 */
const GENERATION_NAME = /^fcc-uls-\d{8}T\d{6}Z(?:-\d+)?\.db$/;

/** Pointer file naming the published generation. */
export const POINTER_FILE = 'current.json';

/** Ingest lock file, holding the PID of the process that owns it. */
export const LOCK_FILE = 'ingest.lock';

/** Claim a process takes, exclusively, while it replaces an ingest lock whose holder is gone. */
export const RECLAIM_FILE = 'ingest.lock.reclaim';

/**
 * A reclaim holds its claim for a few file operations. A claim older than this was left by a
 * reclaim that died mid-step, and is cleared.
 */
const RECLAIM_CLAIM_TTL_MS = 60_000;

/** Compact UTC stamp (`20260927T133855Z`) from an ISO 8601 time. */
export function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Generation file name for a stamp, with an optional disambiguating suffix. */
export function generationFileName(stamp: string, suffix?: string): string {
  return `${GENERATION_PREFIX}${stamp}${suffix ? `-${suffix}` : ''}${GENERATION_SUFFIX}`;
}

/** True for a generation database file name (not its `-wal`/`-shm` sidecars). */
export function isGenerationFile(name: string): boolean {
  return GENERATION_NAME.test(name);
}

/**
 * A generation file name's stamp with its suffix (`fcc-uls-20260927T133855Z-2.db` →
 * `20260927T133855Z-2`): the generation id cursors are bound to.
 */
export function generationStamp(name: string): string {
  return name.slice(GENERATION_PREFIX.length, -GENERATION_SUFFIX.length);
}

/** The published-generation pointer (`current.json`). */
export interface GenerationPointer {
  /** Generation file name, relative to the mirror directory. */
  file: string;
  /** When the generation was published (ISO 8601). */
  publishedAt: string;
}

/** `data.reason` of the error {@link readPointer} throws for a pointer that does not parse. */
const MALFORMED_POINTER = 'malformed_pointer';

/** True for the error {@link readPointer} throws when `current.json` exists but does not parse. */
export function isMalformedPointer(err: unknown): boolean {
  return err instanceof McpError && err.data?.reason === MALFORMED_POINTER;
}

/**
 * Read `current.json`; `undefined` when no generation has been published. A pointer
 * that exists but does not parse is a `SerializationError` with `data.reason`
 * `malformed_pointer` ({@link isMalformedPointer}), never "not built": the ingester
 * writes it atomically, so a bad one means the directory was tampered with. Its message
 * names no filesystem path, so callers can surface it as is.
 */
export async function readPointer(mirrorDir: string): Promise<GenerationPointer | undefined> {
  let text: string;
  try {
    text = await readFile(join(mirrorDir, POINTER_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    'file' in parsed &&
    typeof parsed.file === 'string' &&
    isGenerationFile(parsed.file) &&
    'publishedAt' in parsed &&
    typeof parsed.publishedAt === 'string'
  ) {
    return { file: parsed.file, publishedAt: parsed.publishedAt };
  }
  throw serializationError(
    `${POINTER_FILE} is not a valid generation pointer; rerun mirror:init to republish it.`,
    { reason: MALFORMED_POINTER },
  );
}

/** The process holding the ingest lock, as recorded in the lock file. */
export interface IngestLockHolder {
  mode: string;
  pid: number;
  startedAt: string;
}

/**
 * True when a process with this PID exists (a permission error still means it exists). Zero,
 * negative, and fractional PIDs name no single process (`kill(0)` and `kill(-1)` signal whole
 * process groups and succeed), so a lock recording one has no live holder.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A file's text, or `undefined` when it does not exist. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/** The holder a lock file's text records. */
function parseLockHolder(text: string): IngestLockHolder {
  try {
    const parsed = JSON.parse(text) as Partial<IngestLockHolder>;
    return {
      pid: Number(parsed.pid),
      mode: String(parsed.mode ?? 'unknown'),
      startedAt: String(parsed.startedAt ?? ''),
    };
  } catch {
    // A lock file that does not parse names no live process; the caller reclaims it.
    return { pid: Number.NaN, mode: 'unknown', startedAt: '' };
  }
}

/** The lock holder recorded in `ingest.lock`, or `undefined` when there is no lock file. */
export async function readIngestLock(mirrorDir: string): Promise<IngestLockHolder | undefined> {
  const text = await readOptional(join(mirrorDir, LOCK_FILE));
  return text === undefined ? undefined : parseLockHolder(text);
}

/**
 * Create `path` holding `body` unless it exists. The file appears with its content in place
 * (written to a temp file, then hard-linked), so no reader ever sees it empty or half written.
 */
async function createExclusive(path: string, body: string): Promise<boolean> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, body);
  try {
    await link(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await rm(temp, { force: true });
  }
}

/** Outcome of {@link acquireIngestLock}. */
export type IngestLockAttempt =
  | { reclaimed?: IngestLockHolder; taken: true }
  | { holder: IngestLockHolder; taken: false };

/**
 * Take the ingest lock for `holder`. A lock whose recorded process is gone is reclaimed under
 * {@link RECLAIM_FILE}, taken exclusively: the reclaimer re-reads the lock and, only if it
 * still records the dead holder it found, renames its own lock over it. Two reclaimers of one
 * dead lock never both proceed, and none can replace a lock another process has just taken.
 * When the lock is not taken, returns its live holder or the claimant of a reclaim in progress.
 */
export async function acquireIngestLock(
  mirrorDir: string,
  holder: IngestLockHolder,
): Promise<IngestLockAttempt> {
  const lockPath = join(mirrorDir, LOCK_FILE);
  const body = JSON.stringify(holder);
  let current: IngestLockHolder = { pid: Number.NaN, mode: 'unknown', startedAt: '' };
  // Each retry follows another process's change to the lock; a few always settle it.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(lockPath, body)) return { taken: true };
    const stale = await readOptional(lockPath);
    if (stale === undefined) continue;
    current = parseLockHolder(stale);
    if (isProcessAlive(current.pid)) return { taken: false, holder: current };
    const outcome = await reclaimIngestLock(mirrorDir, stale, body);
    if (outcome === 'replaced') return { taken: true, reclaimed: current };
    if (outcome !== 'changed') return { taken: false, holder: outcome };
  }
  return { taken: false, holder: current };
}

/**
 * Replace a lock still holding `stale` with `body`, under the reclaim claim. `changed` when the
 * lock moved on first; the claimant's holder when another reclaim holds the claim. A claim
 * older than {@link RECLAIM_CLAIM_TTL_MS} is cleared, and the lock is left to the next call.
 */
async function reclaimIngestLock(
  mirrorDir: string,
  stale: string,
  body: string,
): Promise<'changed' | 'replaced' | IngestLockHolder> {
  const claimPath = join(mirrorDir, RECLAIM_FILE);
  if (!(await createExclusive(claimPath, body))) {
    const claim = await readOptional(claimPath);
    if (claim === undefined) return 'changed';
    const claimed = await stat(claimPath).then(
      (info) => info.mtimeMs,
      () => Date.now(),
    );
    if (Date.now() - claimed > RECLAIM_CLAIM_TTL_MS) await rm(claimPath, { force: true });
    return parseLockHolder(claim);
  }
  try {
    const lockPath = join(mirrorDir, LOCK_FILE);
    if ((await readOptional(lockPath)) !== stale) return 'changed';
    const temp = `${lockPath}.${randomUUID()}.tmp`;
    await writeFile(temp, body);
    await rename(temp, lockPath);
    return 'replaced';
  } finally {
    await rm(claimPath, { force: true });
  }
}

/** Remove the ingest lock if it still records `holder`; a lock another process holds stays. */
export async function releaseIngestLock(
  mirrorDir: string,
  holder: IngestLockHolder,
): Promise<void> {
  const lockPath = join(mirrorDir, LOCK_FILE);
  if ((await readOptional(lockPath)) === JSON.stringify(holder)) {
    await rm(lockPath, { force: true });
  }
}

/**
 * Remove an ingest lock that names this process's PID and was taken before this process
 * started, returning the holder it recorded. Such a lock was left by an earlier process that
 * had the same PID, the norm after a container restart (the server is PID 1 again), and
 * {@link isProcessAlive} would otherwise report it held forever. A lock taken since this
 * process started is a live one, held by a process in another PID namespace sharing the
 * mirror directory, and stays.
 */
export async function clearInheritedLock(mirrorDir: string): Promise<IngestLockHolder | undefined> {
  const holder = await readIngestLock(mirrorDir);
  // `startedAt` is in whole seconds, so the lock was taken up to a second after it.
  if (holder?.pid !== process.pid) return;
  if (!(Date.parse(holder.startedAt) + 1000 <= performance.timeOrigin)) return;
  await rm(join(mirrorDir, LOCK_FILE), { force: true });
  return holder;
}

/** Replace `current.json` atomically: write a temp file, then rename over the pointer. */
export async function writePointer(mirrorDir: string, pointer: GenerationPointer): Promise<void> {
  const target = join(mirrorDir, POINTER_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(pointer, null, 2)}\n`);
  await rename(temp, target);
}
