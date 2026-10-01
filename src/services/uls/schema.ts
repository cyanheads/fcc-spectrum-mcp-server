/**
 * @fileoverview The ULS index store spec shared by the ingester (writer) and the index
 * service (reader): the `licenses` primary table with its FTS5 licensee-name index,
 * the auxiliary tables created by migration, generation file naming, and the
 * `current.json` pointer that names the published generation.
 * @module services/uls/schema
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
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
export const SCHEMA_VERSION = 2;

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
  occ_high REAL
);
CREATE INDEX IF NOT EXISTS frequencies_key ON frequencies (usi, location_number);
CREATE INDEX IF NOT EXISTS frequencies_occ_low ON frequencies (occ_low);

CREATE TABLE IF NOT EXISTS market_blocks (
  usi INTEGER NOT NULL,
  partition_area_id INTEGER NOT NULL,
  lower REAL NOT NULL,
  upper REAL
);
CREATE INDEX IF NOT EXISTS market_blocks_usi ON market_blocks (usi);
CREATE INDEX IF NOT EXISTS market_blocks_lower ON market_blocks (lower);

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
  /** Widest occupied band among site frequency rows, in MHz — bounds the `occ_low` range scan. */
  maxSiteBand: 'max_site_band_mhz',
  /** Widest market block, in MHz — bounds the `market_blocks.lower` range scan. */
  maxMarketBand: 'max_market_band_mhz',
  /** Per-group record, site, and frequency counts, as JSON. */
  groupStats: 'group_stats',
} as const;

/** Per-group counts kept in `meta` under {@link META_KEYS.groupStats}. */
export type GroupStats = Record<string, { frequencies: number; records: number; sites: number }>;

/** `ingest_files.stage` values, in step order. A daily file is written once, as `complete`. */
export const INGEST_STAGES = ['downloaded', 'records', 'complete'] as const;

/** Progress of one applied file. */
export type IngestStage = (typeof INGEST_STAGES)[number];

/** Per-record-type line statistics kept in `ingest_files.stats_json`. */
export type RecordStats = Record<
  string,
  { kept: number; read: number; rejected: number; orphaned?: number }
>;

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
    ],
  });
}

/** Prefix and suffix of generation file names: `fcc-uls-<stamp>.db`. */
const GENERATION_PREFIX = 'fcc-uls-';
const GENERATION_SUFFIX = '.db';

/** Pointer file naming the published generation. */
export const POINTER_FILE = 'current.json';

/** Ingest lock file, holding the PID of the process that owns it. */
export const LOCK_FILE = 'ingest.lock';

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
  return name.startsWith(GENERATION_PREFIX) && name.endsWith(GENERATION_SUFFIX);
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

/** True when a process with this PID exists (a permission error still means it exists). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock holder recorded in `ingest.lock`, or `undefined` when there is no lock file. */
export async function readIngestLock(mirrorDir: string): Promise<IngestLockHolder | undefined> {
  let text: string;
  try {
    text = await readFile(join(mirrorDir, LOCK_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<IngestLockHolder>;
    return {
      pid: Number(parsed.pid),
      mode: String(parsed.mode ?? 'unknown'),
      startedAt: String(parsed.startedAt ?? ''),
    };
  } catch {
    // A lock file cut off mid-write names no live process; the caller reclaims it.
    return { pid: Number.NaN, mode: 'unknown', startedAt: '' };
  }
}

/**
 * Remove an ingest lock that names this process's PID, returning the holder it recorded.
 * Call it only at process startup, before this process can take the lock: a lock naming the
 * current PID was then left by an earlier process that had the same PID, which is the norm
 * after a container restart (the server is PID 1 again), and {@link isProcessAlive} would
 * otherwise report it held forever.
 */
export async function clearInheritedLock(mirrorDir: string): Promise<IngestLockHolder | undefined> {
  const holder = await readIngestLock(mirrorDir);
  if (holder?.pid !== process.pid) return;
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
