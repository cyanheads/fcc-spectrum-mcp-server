/**
 * @fileoverview `UlsIndexService` — the read path over the published ULS index
 * generation: readiness and coverage, license search, full license detail, radius search
 * over transmitter sites, and occupied-band overlap search over site assignments and
 * market blocks. It follows `current.json` to the published generation, re-checking the
 * pointer at most once per `pointerCheckMs` and swapping handles when a rebuild publishes.
 * Individual-licensee redaction happens here, in one function, at read time.
 * @module services/uls/uls-index-service
 */

import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { internalError, type McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorStore, SqliteHandle, SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import {
  LICENSE_STATUSES,
  LOCATION_TYPES,
  OPERATOR_CLASSES,
  RADIO_SERVICES,
  SERVICE_GROUPS,
  type ServiceGroup,
} from './codes.js';
import {
  bandClassBounds,
  createUlsStore,
  type GenerationPointer,
  type GroupStats,
  isGenerationFile,
  isMalformedPointer,
  isProcessAlive,
  LIVE_STATUSES,
  META_KEYS,
  POINTER_FILE,
  readIngestLock,
  readPointer,
} from './schema.js';
import type {
  Band,
  Coverage,
  FindTransmittersParams,
  FrequencyAssignment,
  GetLicenseParams,
  GetLicenseResult,
  GroupCoverage,
  IndexedServiceCode,
  IndexState,
  LicenseAntenna,
  LicenseDetail,
  LicenseeFields,
  LicenseLocation,
  LicenseSite,
  LicenseSummary,
  LiveStatusFilter,
  PageResult,
  RadioServiceClass,
  SearchFrequenciesParams,
  SearchLicensesParams,
  SiteFrequency,
  TransmitterSite,
} from './types.js';

/** Constructor options. `mirrorDir`, `pointerCheckMs`, and `now` are the test seams. */
export interface UlsIndexServiceOptions {
  /** Directory holding generation files and `current.json`. */
  mirrorDir: string;
  now?: () => number;
  /** Minimum gap between pointer checks, in ms (default one minute; 0 checks every call). */
  pointerCheckMs?: number;
  /** Withhold individual licensees' names, cities, and site addresses, and trustee names. */
  redactIndividuals: boolean;
  /** Service groups this deployment is configured to index. */
  services: readonly ServiceGroup[];
}

/** Half a hertz, in MHz: the tolerance of every band-overlap test. */
const OVERLAP_EPSILON_MHZ = 0.0000005;

/** Mean Earth radius (IUGG), km. */
const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEGREE = (Math.PI * EARTH_RADIUS_KM) / 180;

/**
 * What one `getLicense` call lists of each repeating section: the location window holds
 * whole locations up to this many sites and antennas (one location larger than either is
 * listed alone), and leases are listed this many at a time. Frequency rows are capped by the
 * caller's `maxFrequencies`.
 */
export const LICENSE_PAGE = { sites: 50, antennas: 100, leases: 100 } as const;

/** Callsign-prefix candidates offered on a miss. */
const MAX_CANDIDATES = 5;

const GENERATION_PREFIX = 'fcc-uls-';

/** A published generation, opened. */
interface OpenGeneration {
  db: SqliteHandle;
  file: string;
  /** The generation's stamp, bound into every cursor. */
  id: string;
  publishedAt: string;
  ready: boolean;
  store: MirrorStore;
}

/** A `licenses` row. `license_status`, `radio_service_code`, and `service_group` are always set. */
interface LicenseRow {
  applicant_type: string | null;
  callsign: string | null;
  cancellation_date: string | null;
  channel_block: string | null;
  effective_date: string | null;
  expired_date: string | null;
  frn: string | null;
  grant_date: string | null;
  is_individual: number;
  is_lease: number;
  last_action_date: string | null;
  license_status: string;
  licensee_city: string | null;
  licensee_name: string | null;
  licensee_state: string | null;
  market_code: string | null;
  market_name: string | null;
  operator_class: string | null;
  previous_callsign: string | null;
  radio_service_code: string;
  service_group: string;
  trustee_callsign: string | null;
  trustee_name: string | null;
  usi: number;
}

interface LocationRow {
  address: string | null;
  asr_number: string | null;
  city: string | null;
  coord_dms: string | null;
  county: string | null;
  ground_elevation_m: number | null;
  lat: number | null;
  location_class: string | null;
  location_name: string | null;
  location_number: number;
  location_type: string | null;
  lon: number | null;
  overall_height_m: number | null;
  radius_km: number | null;
  /** Numbers the sites a license files under one location number, 1, 2, … in filing order. */
  site_seq: number;
  site_state: string | null;
  state_derived: number;
  structure_type: string | null;
  support_height_m: number | null;
  usi: number;
}

interface AntennaRow {
  antenna_number: number;
  antenna_type: string | null;
  azimuth_deg: number | null;
  beamwidth_deg: number | null;
  gain_dbi: number | null;
  haat_m: number | null;
  height_to_center_m: number | null;
  height_to_tip_m: number | null;
  location_number: number;
  make: string | null;
  model: string | null;
  polarization: string | null;
}

interface FrequencyRow {
  antenna_number: number;
  bandwidth_mhz: number | null;
  class_station: string | null;
  eirp_dbm: number | null;
  emissions: string | null;
  erp_w: number | null;
  frequency_mhz: number;
  location_number: number;
  power_output_w: number | null;
  transmitter_make: string | null;
  transmitter_model: string | null;
  upper_mhz: number | null;
}

/** The license columns every site and assignment row carries. */
type LicenseHeadRow = Pick<
  LicenseRow,
  | 'callsign'
  | 'is_individual'
  | 'is_lease'
  | 'license_status'
  | 'licensee_name'
  | 'radio_service_code'
  | 'usi'
>;

const LICENSE_HEAD_COLUMNS =
  'l.usi, l.callsign, l.license_status, l.radio_service_code, l.licensee_name, l.is_individual, l.is_lease';

type CursorKey = (string | number)[];

/** Omit a field whose value is null or undefined; with `exactOptionalPropertyTypes` a field is present or absent. */
function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** FCC label for a radio service code, falling back to the code itself. */
export function radioServiceLabel(code: string): string {
  return RADIO_SERVICES[code] ?? code;
}

/** FCC label for a license status code, falling back to the code itself. */
function statusLabel(code: string): string {
  return LICENSE_STATUSES[code] ?? code;
}

/** SQL list of the statuses a live-status filter selects. */
function liveStatuses(status: LiveStatusFilter): readonly string[] {
  return status === 'any' ? LIVE_STATUSES : [status];
}

/**
 * The distinct partition areas a market band is filed under, comma-joined, over rows of
 * `market_blocks mb` grouped by `(usi, lower, upper)`. A blank area (stored as `0`) is dropped.
 */
const PARTITION_AREAS_SQL = 'group_concat(DISTINCT NULLIF(mb.partition_area_id, 0))';

/** {@link PARTITION_AREAS_SQL} as numbers, ascending; `undefined` when every area was blank. */
function partitionAreaIds(concat: string | null): number[] | undefined {
  return concat
    ?.split(',')
    .map(Number)
    .toSorted((a, b) => a - b);
}

/**
 * Translate a licensee name into an FTS5 query: each whitespace-separated word becomes one
 * double-quoted term, AND-ed (`"acme"* "wireless"*`). A word the index tokenizer splits on
 * punctuation (`T-Mobile`, `AT&T`) stays one phrase of its pieces (`"t mobile"*`, `"at t"`),
 * so its one-letter pieces cannot match as separate words. A term's last piece is a prefix
 * unless it is a single character, which would match nearly every name. Splitting on
 * non-letters matches the tokenizer and leaves no FTS operator in the query. `undefined` when
 * the text has no word to search.
 */
function ftsQuery(text: string): string | undefined {
  const terms = text
    .normalize('NFKC')
    .split(/\s+/u)
    .map((word) => word.split(/[^\p{L}\p{N}]+/u).filter(Boolean))
    .filter((pieces) => pieces.length > 0)
    .map((pieces) => `"${pieces.join(' ')}"${(pieces.at(-1)?.length ?? 0) > 1 ? '*' : ''}`);
  return terms.length ? terms.join(' ') : undefined;
}

function encodeCursor(generation: string, tag: string, key: CursorKey): string {
  return Buffer.from(JSON.stringify([generation, tag, ...key])).toString('base64url');
}

/**
 * Decode a cursor minted for this generation and query shape; `undefined` when it does
 * not decode, belongs to another generation (a rebuild happened), or has the wrong shape.
 */
function decodeCursor(
  cursor: string,
  generation: string,
  tag: string,
  shape: readonly ('number' | 'string' | 'string?')[],
): (string | number | null)[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(parsed) || parsed[0] !== generation || parsed[1] !== tag) return;
  const key = parsed.slice(2) as unknown[];
  if (key.length !== shape.length) return;
  const valid = key.every((value, i) => {
    const kind = shape[i];
    if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (kind === 'string?') return value === null || typeof value === 'string';
    return typeof value === 'string';
  });
  return valid ? (key as (string | number | null)[]) : undefined;
}

/** Lexicographic comparison of numeric/string key tuples. */
function compareKeys(a: CursorKey, b: CursorKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Bounding box around a point, as a latitude range and one or two longitude ranges (two
 * when the box crosses the antimeridian). Conservative: the haversine filter follows.
 */
function boundingBox(
  latitude: number,
  longitude: number,
  radiusKm: number,
): { lat: [number, number]; lon: [number, number][] } {
  const dLat = radiusKm / KM_PER_DEGREE;
  const lat: [number, number] = [Math.max(-90, latitude - dLat), Math.min(90, latitude + dLat)];
  const farthestLat = Math.min(90, Math.abs(latitude) + dLat);
  if (farthestLat >= 89.9) return { lat, lon: [[-180, 180]] };
  const dLon = dLat / Math.cos((farthestLat * Math.PI) / 180);
  if (dLon >= 180) return { lat, lon: [[-180, 180]] };
  const west = longitude - dLon;
  const east = longitude + dLon;
  if (west < -180)
    return {
      lat,
      lon: [
        [west + 360, 180],
        [-180, east],
      ],
    };
  if (east > 180)
    return {
      lat,
      lon: [
        [west, 180],
        [-180, east - 360],
      ],
    };
  return { lat, lon: [[west, east]] };
}

/**
 * Collapse a site's frequency rows (already ordered by frequency) on `(frequency, upper)`
 * across antennas and modulation steps: distinct station classes and emissions, the widest
 * bandwidth, and the highest ERP and EIRP.
 */
function collapseFrequencies(
  rows: Pick<
    FrequencyRow,
    | 'bandwidth_mhz'
    | 'class_station'
    | 'eirp_dbm'
    | 'emissions'
    | 'erp_w'
    | 'frequency_mhz'
    | 'upper_mhz'
  >[],
): SiteFrequency[] {
  const groups = new Map<
    string,
    {
      bandwidth: number | null;
      classes: Set<string>;
      eirp: number | null;
      emissions: Set<string>;
      erp: number | null;
      frequency: number;
      upper: number | null;
    }
  >();
  const max = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : Math.max(a, b);
  for (const row of rows) {
    const key = `${row.frequency_mhz}|${row.upper_mhz ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        frequency: row.frequency_mhz,
        upper: row.upper_mhz,
        bandwidth: null,
        classes: new Set(),
        emissions: new Set(),
        erp: null,
        eirp: null,
      };
      groups.set(key, group);
    }
    group.bandwidth = max(group.bandwidth, row.bandwidth_mhz);
    group.erp = max(group.erp, row.erp_w);
    group.eirp = max(group.eirp, row.eirp_dbm);
    if (row.class_station) group.classes.add(row.class_station);
    for (const code of row.emissions?.split(',') ?? []) if (code) group.emissions.add(code);
  }
  return [...groups.values()].map((group) => ({
    frequencyMhz: group.frequency,
    ...opt('upperMhz', group.upper),
    ...opt('bandwidthMhz', group.bandwidth),
    stationClasses: [...group.classes],
    ...opt('maxErpW', group.erp),
    ...opt('maxEirpDbm', group.eirp),
    emissions: [...group.emissions],
  }));
}

/** One LO row's site fields; the street address only when redaction leaves it visible. */
function siteFields(lo: LocationRow, addressVisible: boolean): LicenseSite {
  return {
    ...opt('locationTypeCode', lo.location_type),
    ...opt('locationTypeLabel', lo.location_type && LOCATION_TYPES[lo.location_type]),
    ...opt('locationClassCode', lo.location_class),
    ...opt('latitude', lo.lat),
    ...opt('longitude', lo.lon),
    ...opt('coordinatesDms', lo.coord_dms),
    ...opt('groundElevationM', lo.ground_elevation_m),
    ...opt('supportHeightM', lo.support_height_m),
    ...opt('overallHeightM', lo.overall_height_m),
    ...opt('structureType', lo.structure_type),
    ...opt('asrNumber', lo.asr_number),
    ...opt('radiusKm', lo.radius_km),
    ...(addressVisible && opt('address', lo.address)),
    ...opt('city', lo.city),
    ...opt('county', lo.county),
    ...opt('state', lo.site_state),
    ...(lo.site_state !== null && { stateFromCoordinates: lo.state_derived === 1 }),
    ...opt('name', lo.location_name),
  };
}

/** Read path over the published ULS index generation. */
export class UlsIndexService {
  private current: OpenGeneration | undefined;
  private lastPointerCheck = Number.NEGATIVE_INFINITY;
  private pointerMtime: number | undefined;
  private pendingCheck: Promise<OpenGeneration | undefined> | undefined;
  /**
   * Why `current.json` serves no generation — it names a missing file, or does not parse —
   * as caller-facing text free of filesystem paths; `undefined` otherwise.
   */
  private pointerProblem: string | undefined;
  private readonly mirrorDir: string;
  private readonly now: () => number;
  private readonly pointerCheckMs: number;
  /** Whether individual licensees are redacted. */
  readonly redactIndividuals: boolean;
  /** Service groups this deployment is configured to index. */
  readonly services: readonly ServiceGroup[];

  constructor(options: UlsIndexServiceOptions) {
    this.mirrorDir = options.mirrorDir;
    this.now = options.now ?? Date.now;
    this.pointerCheckMs = options.pointerCheckMs ?? 60_000;
    this.redactIndividuals = options.redactIndividuals;
    this.services = options.services;
  }

  // --- Readiness and coverage -----------------------------------------------------------

  /** True when a completed index generation is published. */
  async ready(): Promise<boolean> {
    return (await this.generation())?.ready ?? false;
  }

  /** Creation time of the newest applied ULS file, or `undefined` before the index is built. */
  async dataAsOf(): Promise<string | undefined> {
    const generation = await this.generation();
    return generation?.ready ? readDataAsOf(generation.db) : undefined;
  }

  /**
   * Build state, per-group coverage, and the redaction setting. Works on a cold index, and
   * over a dangling or malformed `current.json`, which it reports as the index `error`.
   */
  async coverage(): Promise<Coverage> {
    const generation = await this.generation();
    const index: IndexState = { ready: false, status: 'none' };
    let groups: GroupCoverage[] = SERVICE_GROUPS.map((group) => ({ group, indexed: false }));

    if (generation?.ready) {
      const { db } = generation;
      const weekly = new Map(
        db
          .prepare<{ counts_created: string; service_group: string; stage: string }>(
            "SELECT service_group, counts_created, stage FROM ingest_files WHERE kind = 'weekly'",
          )
          .all()
          .map((row) => [row.service_group, row]),
      );
      const stats = readGroupStats(db);
      const lastDaily = db
        .prepare<{ latest: string | null }>(
          "SELECT max(counts_created) AS latest FROM ingest_files WHERE kind = 'daily'",
        )
        .get()?.latest;
      const dataAsOf = readDataAsOf(db);
      const state = await generation.store.readState();
      Object.assign(index, {
        ready: true,
        status: 'ready',
        generation: generation.file,
        lastFullBuild: generation.publishedAt,
        ...opt('lastDailyApplied', lastDaily),
        ...opt('dataAsOf', dataAsOf),
        ...(state.status === 'error' && opt('error', this.callerSafe(state.error))),
      });
      groups = SERVICE_GROUPS.map((group) => {
        const file = weekly.get(group);
        if (file?.stage !== 'complete') return { group, indexed: false };
        const counts = stats[group];
        return {
          group,
          indexed: true,
          records: counts?.records ?? 0,
          sites: counts?.sites ?? 0,
          frequencies: counts?.frequencies ?? 0,
          snapshotCreated: file.counts_created,
        };
      });
    } else {
      const lock = await readIngestLock(this.mirrorDir);
      if (lock && isProcessAlive(lock.pid)) index.status = 'building';
      else {
        Object.assign(index, opt('error', this.pointerProblem ?? (await this.failedBuildError())));
      }
    }
    return { index, groups, redactIndividuals: this.redactIndividuals };
  }

  /**
   * Radio service codes the index holds, with their group and record count; `undefined`
   * before the index is built.
   */
  async serviceCodes(): Promise<Map<string, IndexedServiceCode> | undefined> {
    const generation = await this.generation();
    if (!generation?.ready) return;
    const rows = generation.db
      .prepare<{ code: string; record_count: number; service_group: string }>(
        'SELECT code, service_group, record_count FROM service_codes',
      )
      .all();
    return new Map(
      rows.map((row) => [row.code, { group: row.service_group, records: row.record_count }]),
    );
  }

  /**
   * `indexed` when the index holds the code; `not_indexed` when the FCC table knows it but
   * no loaded group carries it; `unknown` otherwise.
   */
  async classifyRadioService(code: string): Promise<RadioServiceClass> {
    const generation = await this.generation();
    // Drivers differ on a missing row (bun:sqlite returns null, better-sqlite3 undefined).
    const held =
      generation?.ready &&
      Boolean(generation.db.prepare('SELECT 1 FROM service_codes WHERE code = ?').get(code));
    if (held) return 'indexed';
    return Object.hasOwn(RADIO_SERVICES, code) ? 'not_indexed' : 'unknown';
  }

  // --- search_licenses ------------------------------------------------------------------

  /**
   * Search licenses and leases. With `licensee`, rows rank by FTS bm25 then USI, and
   * individual records are excluded while redaction is on; otherwise they sort by callsign
   * then USI. Keyset-paginated with a generation-bound cursor; a rank-order cursor is also
   * bound to the daily files applied, since each one shifts the corpus statistics bm25 scores
   * from.
   */
  async searchLicenses(params: SearchLicensesParams): Promise<PageResult<LicenseSummary>> {
    const { db, id } = await this.requireGeneration();
    const where: string[] = [];
    const args: SqlValue[] = [];
    const filter = (clause: string, value: SqlValue) => {
      where.push(clause);
      args.push(value);
    };
    if (params.callsign) filter('l.callsign = ?', params.callsign);
    if (params.frn) filter('l.frn = ?', params.frn);
    if (params.radioService) filter('l.radio_service_code = ?', params.radioService);
    if (params.status !== 'any') filter('l.license_status = ?', params.status);
    if (params.state) filter('l.licensee_state = ?', params.state);

    if (params.licensee === undefined)
      return this.searchByCallsignOrder(db, id, params, where, args);

    const match = ftsQuery(params.licensee);
    if (!match) return { ok: true, rows: [], total: 0 };
    if (this.redactIndividuals) where.push('l.is_individual = 0');
    const base = `FROM licenses_fts JOIN licenses l ON l.usi = licenses_fts.rowid
      WHERE licenses_fts MATCH ?${where.map((clause) => ` AND ${clause}`).join('')}`;
    const baseArgs = [match, ...args];
    // Read before the rows: a refresh committing in between then fails the next page.
    const scoreState = `${id}+${readRefreshState(db)}`;

    let keyset = '';
    const keysetArgs: SqlValue[] = [];
    if (params.cursor) {
      const key = decodeCursor(params.cursor, scoreState, 'r', ['number', 'number']);
      if (!key) return { ok: false, reason: 'invalid_cursor' };
      keyset = 'WHERE (score, usi) > (?, ?)';
      keysetArgs.push(...(key as number[]));
    }
    const total =
      db.prepare<{ n: number }>(`SELECT count(*) AS n ${base}`).get(...baseArgs)?.n ?? 0;
    const rows = db
      .prepare<LicenseRow & { score: number }>(
        `SELECT * FROM (SELECT l.*, bm25(licenses_fts) AS score ${base})
         ${keyset} ORDER BY score, usi LIMIT ?`,
      )
      .all(...baseArgs, ...keysetArgs, params.limit + 1);
    const last = rows[params.limit - 1];
    return {
      ok: true,
      total,
      rows: this.licenseSummaries(db, rows.slice(0, params.limit)),
      ...(rows.length > params.limit &&
        last && { nextCursor: encodeCursor(scoreState, 'r', [last.score, last.usi]) }),
    };
  }

  private searchByCallsignOrder(
    db: SqliteHandle,
    id: string,
    params: SearchLicensesParams,
    where: string[],
    args: SqlValue[],
  ): PageResult<LicenseSummary> {
    const total =
      db
        .prepare<{ n: number }>(
          `SELECT count(*) AS n FROM licenses l${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
        )
        .get(...args)?.n ?? 0;

    const pageWhere = [...where];
    const pageArgs = [...args];
    if (params.cursor) {
      const key = decodeCursor(params.cursor, id, 'c', ['string?', 'number']);
      if (!key) return { ok: false, reason: 'invalid_cursor' };
      const [callsign, usi] = key as [string | null, number];
      // ULS files a few old records without a callsign; they sort first (NULL) in callsign order.
      if (callsign === null) {
        pageWhere.push('((l.callsign IS NULL AND l.usi > ?) OR l.callsign IS NOT NULL)');
        pageArgs.push(usi);
      } else {
        pageWhere.push('(l.callsign > ? OR (l.callsign = ? AND l.usi > ?))');
        pageArgs.push(callsign, callsign, usi);
      }
    }
    const rows = db
      .prepare<LicenseRow>(
        `SELECT l.* FROM licenses l${pageWhere.length ? ` WHERE ${pageWhere.join(' AND ')}` : ''}
         ORDER BY l.callsign, l.usi LIMIT ?`,
      )
      .all(...pageArgs, params.limit + 1);
    const last = rows[params.limit - 1];
    return {
      ok: true,
      total,
      rows: this.licenseSummaries(db, rows.slice(0, params.limit)),
      ...(rows.length > params.limit &&
        last && {
          nextCursor: encodeCursor(id, 'c', [last.callsign ?? null, last.usi] as CursorKey),
        }),
    };
  }

  private licenseSummaries(db: SqliteHandle, rows: LicenseRow[]): LicenseSummary[] {
    const locationCount = db.prepare<{ n: number }>(
      'SELECT count(*) AS n FROM locations WHERE usi = ?',
    );
    // Only showable rows, as get_license counts them: a row with no assigned frequency is never listed.
    const frequencyCount = db.prepare<{ n: number }>(
      'SELECT count(*) AS n FROM frequencies WHERE usi = ? AND frequency_mhz IS NOT NULL',
    );
    return rows.map((row) =>
      this.licenseSummary(row, {
        locations: locationCount.get(row.usi)?.n ?? 0,
        frequencies: frequencyCount.get(row.usi)?.n ?? 0,
      }),
    );
  }

  private licenseSummary(
    row: LicenseRow,
    counts: { frequencies: number; locations: number },
  ): LicenseSummary {
    const shown = this.redact(row);
    return {
      usi: String(row.usi),
      ...opt('callsign', row.callsign),
      isLease: row.is_lease === 1,
      licenseStatus: row.license_status,
      statusLabel: statusLabel(row.license_status),
      radioServiceCode: row.radio_service_code,
      radioServiceLabel: radioServiceLabel(row.radio_service_code),
      serviceGroup: row.service_group,
      licenseeName: shown.licenseeName,
      licenseeRedacted: shown.licenseeRedacted,
      ...opt('frn', row.frn),
      ...opt('applicantType', row.applicant_type),
      ...opt('licenseeCity', shown.licenseeCity),
      ...opt('licenseeState', row.licensee_state),
      ...opt('grantDate', row.grant_date),
      ...opt('expiredDate', row.expired_date),
      ...opt('cancellationDate', row.cancellation_date),
      ...opt('lastActionDate', row.last_action_date),
      locationCount: counts.locations,
      frequencyCount: counts.frequencies,
      ...opt('marketCode', row.market_code),
      ...opt('marketName', row.market_name),
    };
  }

  // --- get_license ----------------------------------------------------------------------

  /**
   * One license or lease in full, by USI or callsign. A callsign shared by several records
   * resolves to the active one, else the most recent; the others are listed. A miss
   * returns up to five callsign-prefix candidates.
   */
  async getLicense(params: GetLicenseParams): Promise<GetLicenseResult> {
    const { db } = await this.requireGeneration();
    let row: LicenseRow | undefined;
    let others: { license_status: string; usi: number }[] = [];
    if (params.usi !== undefined) {
      row = db.prepare<LicenseRow>('SELECT * FROM licenses WHERE usi = ?').get(Number(params.usi));
      if (!row) return { found: false, candidates: [] };
      if (row.callsign) {
        others = db
          .prepare<{ license_status: string; usi: number }>(
            'SELECT usi, license_status FROM licenses WHERE callsign = ? AND usi <> ? ORDER BY usi',
          )
          .all(row.callsign, row.usi);
      }
    } else {
      const callsign = params.callsign ?? '';
      const rows = db
        .prepare<LicenseRow>(
          `SELECT * FROM licenses WHERE callsign = ?
           ORDER BY license_status = 'A' DESC,
             COALESCE(last_action_date, effective_date, grant_date, '') DESC, usi DESC`,
        )
        .all(callsign);
      row = rows[0];
      if (!row) {
        const candidates = db
          .prepare<{ callsign: string; license_status: string; usi: number }>(
            `SELECT callsign, usi, license_status FROM licenses
             WHERE callsign >= ? AND callsign < ? ORDER BY callsign, usi LIMIT ${MAX_CANDIDATES}`,
          )
          .all(callsign, `${callsign}~`);
        return {
          found: false,
          candidates: candidates.map((candidate) => ({
            callsign: candidate.callsign,
            usi: String(candidate.usi),
            licenseStatus: candidate.license_status,
          })),
        };
      }
      others = rows.slice(1);
    }

    const technicalRetained = (LIVE_STATUSES as readonly string[]).includes(row.license_status);
    const window = technicalRetained
      ? this.locationWindow(db, row.usi, params.locationOffset ?? 0, params.maxFrequencies)
      : undefined;
    const { locations, shown } = window?.range
      ? this.licenseLocations(db, row, window.range, params.maxFrequencies)
      : { locations: [], shown: 0 };
    const { license, nextLeaseOffset } = this.licenseDetail(db, row, params.leaseOffset ?? 0);
    return {
      found: true,
      license,
      technicalRetained,
      locations,
      otherCallsignRecords: others.map((other) => ({
        usi: String(other.usi),
        licenseStatus: other.license_status,
      })),
      frequencyTotal: window?.frequencyTotal ?? 0,
      frequenciesShown: shown,
      locationTotal: window?.locationTotal ?? 0,
      siteTotal: window?.siteTotal ?? 0,
      sitesShown: window?.sitesShown ?? 0,
      windowFrequencyTotal: window?.windowFrequencyTotal ?? 0,
      ...(window?.nextOffset !== undefined && { nextLocationOffset: window.nextOffset }),
      ...(window?.cutAt && { frequencyCutAt: window.cutAt }),
      ...(nextLeaseOffset !== undefined && { nextLeaseOffset }),
    };
  }

  /**
   * The window of location numbers one `getLicense` call lists: whole locations from
   * `offset`, in number order, until the next would pass {@link LICENSE_PAGE}'s site or
   * antenna budget. The first location is always listed, so one larger than a budget is
   * listed alone rather than split. Sites count every site of a shared number; antennas and
   * frequency rows count those {@link licenseLocations} lists. `cutAt` is the first location
   * whose frequency rows `maxFrequencies` drops, since rows are read in location order.
   */
  private locationWindow(db: SqliteHandle, usi: number, offset: number, maxFrequencies: number) {
    const summary = new Map<
      number,
      { antennas: Set<number>; frequencies: number; sites: number }
    >();
    const entry = (number: number) => {
      let counts = summary.get(number);
      if (!counts) {
        counts = { antennas: new Set(), frequencies: 0, sites: 0 };
        summary.set(number, counts);
      }
      return counts;
    };
    for (const { n, count } of db
      .prepare<{ count: number; n: number }>(
        'SELECT location_number AS n, count(*) AS count FROM locations WHERE usi = ? GROUP BY n',
      )
      .all(usi)) {
      entry(n).sites = count;
    }
    for (const { n, a } of db
      .prepare<{ a: number; n: number }>(
        'SELECT location_number AS n, antenna_number AS a FROM antennas WHERE usi = ?',
      )
      .all(usi)) {
      entry(n).antennas.add(a);
    }
    for (const { n, a, count } of db
      .prepare<{ a: number; count: number; n: number }>(
        `SELECT location_number AS n, antenna_number AS a, count(*) AS count FROM frequencies
         WHERE usi = ? AND frequency_mhz IS NOT NULL GROUP BY n, a`,
      )
      .all(usi)) {
      const counts = entry(n);
      counts.antennas.add(a);
      counts.frequencies += count;
    }
    const ordered = [...summary].sort(([a], [b]) => a - b);

    const listed: number[] = [];
    let sites = 0;
    let antennas = 0;
    let frequencies = 0;
    let cutAt: { locationNumber: number; offset: number } | undefined;
    for (const [number, counts] of ordered.slice(offset)) {
      const over =
        sites + counts.sites > LICENSE_PAGE.sites ||
        antennas + counts.antennas.size > LICENSE_PAGE.antennas;
      if (listed.length > 0 && over) break;
      if (!cutAt && frequencies + counts.frequencies > maxFrequencies) {
        cutAt = { locationNumber: number, offset: offset + listed.length };
      }
      listed.push(number);
      sites += counts.sites;
      antennas += counts.antennas.size;
      frequencies += counts.frequencies;
    }
    const [first] = listed;
    const last = listed.at(-1);
    const end = offset + listed.length;
    return {
      range: first !== undefined && last !== undefined ? { first, last } : undefined,
      cutAt,
      locationTotal: ordered.length,
      siteTotal: ordered.reduce((sum, [, counts]) => sum + counts.sites, 0),
      sitesShown: sites,
      frequencyTotal: ordered.reduce((sum, [, counts]) => sum + counts.frequencies, 0),
      windowFrequencyTotal: frequencies,
      ...(end < ordered.length && { nextOffset: end }),
    };
  }

  /**
   * The license record with one page of its leases from `leaseOffset`, in lease-ID order,
   * and the offset of the next page when more follow.
   */
  private licenseDetail(
    db: SqliteHandle,
    row: LicenseRow,
    leaseOffset: number,
  ): { license: LicenseDetail; nextLeaseOffset?: number } {
    const shown = this.redact(row);
    const leasedFrom = db
      .prepare<{ callsign: string | null; usi: number }>(
        `SELECT COALESCE(ll.parent_callsign, p.callsign) AS callsign, ll.parent_usi AS usi
         FROM lease_links ll LEFT JOIN licenses p ON p.usi = ll.parent_usi
         WHERE ll.lease_usi = ? ORDER BY ll.parent_usi`,
      )
      .all(row.usi);
    const leaseCount =
      db
        .prepare<{ n: number }>('SELECT count(*) AS n FROM lease_links WHERE parent_usi = ?')
        .get(row.usi)?.n ?? 0;
    // One row past the page says whether another page follows.
    const leaseRows = db
      .prepare<{ callsign: string | null; license_status: string; usi: number }>(
        `SELECT l.callsign, l.usi, l.license_status FROM lease_links ll
         JOIN licenses l ON l.usi = ll.lease_usi
         WHERE ll.parent_usi = ? ORDER BY l.callsign, l.usi LIMIT ? OFFSET ?`,
      )
      .all(row.usi, LICENSE_PAGE.leases + 1, leaseOffset);
    const leases = leaseRows.slice(0, LICENSE_PAGE.leases);
    const hasAmateur =
      row.operator_class !== null ||
      row.trustee_callsign !== null ||
      row.previous_callsign !== null ||
      row.trustee_name !== null;
    const blocks = row.market_code
      ? db
          .prepare<{ lower: number; partitions: string | null; upper: number | null }>(
            `SELECT mb.lower, mb.upper, ${PARTITION_AREAS_SQL} AS partitions
             FROM market_blocks mb WHERE mb.usi = ?
             GROUP BY mb.lower, mb.upper ORDER BY mb.lower, mb.upper`,
          )
          .all(row.usi)
      : [];

    const license: LicenseDetail = {
      usi: String(row.usi),
      ...opt('callsign', row.callsign),
      isLease: row.is_lease === 1,
      licenseStatus: row.license_status,
      statusLabel: statusLabel(row.license_status),
      radioServiceCode: row.radio_service_code,
      radioServiceLabel: radioServiceLabel(row.radio_service_code),
      serviceGroup: row.service_group,
      ...opt('grantDate', row.grant_date),
      ...opt('effectiveDate', row.effective_date),
      ...opt('expiredDate', row.expired_date),
      ...opt('cancellationDate', row.cancellation_date),
      ...opt('lastActionDate', row.last_action_date),
      licensee: {
        name: shown.licenseeName,
        redacted: shown.licenseeRedacted,
        role: row.is_lease === 1 ? 'lessee' : 'licensee',
        ...opt('frn', row.frn),
        ...opt('applicantType', row.applicant_type),
        ...opt('city', shown.licenseeCity),
        ...opt('state', row.licensee_state),
      },
      ...(hasAmateur && {
        amateur: {
          ...opt('operatorClass', row.operator_class),
          ...opt('operatorClassLabel', row.operator_class && OPERATOR_CLASSES[row.operator_class]),
          ...opt('trusteeCallsign', row.trustee_callsign),
          ...(row.trustee_name !== null && { trusteeName: shown.trusteeName }),
          ...opt('previousCallsign', row.previous_callsign),
        },
      }),
      ...(row.market_code && {
        market: {
          marketCode: row.market_code,
          ...opt('marketName', row.market_name),
          ...opt('channelBlock', row.channel_block),
          blocks: blocks.map((block) => ({
            ...(block.lower > 0
              ? { lowMhz: block.lower, highMhz: block.upper ?? block.lower }
              : opt('channelWidthMhz', block.upper)),
            ...opt('partitionAreaIds', partitionAreaIds(block.partitions)),
          })),
        },
      }),
      leasedFrom: leasedFrom.map((parent) => ({
        ...opt('callsign', parent.callsign),
        usi: String(parent.usi),
      })),
      leases: leases.map((lease) => ({
        ...opt('callsign', lease.callsign),
        usi: String(lease.usi),
        licenseStatus: lease.license_status,
      })),
      leaseCount,
    };
    return leaseRows.length > LICENSE_PAGE.leases
      ? { license, nextLeaseOffset: leaseOffset + LICENSE_PAGE.leases }
      : { license };
  }

  /**
   * Locations → antennas → frequencies for a live record's location numbers `range.first`
   * through `range.last`. Frequency rows are read in `(location, antenna, freq_seq_id)` order
   * and capped at `maxFrequencies`, so the cap drops the last locations' rows first. A row
   * whose antenna or location has no record of its own is kept under a bare antenna or
   * location entry rather than dropped. A location number filed at several sites lists them
   * in `sites`; AN and FR rows carry only the number, so its antennas stay on the entry, each
   * merged across the AN records filed for it (a field is kept only when every record agrees
   * on it).
   */
  private licenseLocations(
    db: SqliteHandle,
    row: LicenseRow,
    range: { first: number; last: number },
    maxFrequencies: number,
  ): { locations: LicenseLocation[]; shown: number } {
    const { siteAddressVisible } = this.redact(row);
    const locations = new Map<number, LicenseLocation>();
    const antennas = new Map<string, LicenseAntenna>();
    const location = (number: number) => {
      let entry = locations.get(number);
      if (!entry) {
        entry = { locationNumber: number, antennas: [] };
        locations.set(number, entry);
      }
      return entry;
    };
    const antenna = (locationNumber: number, antennaNumber: number) => {
      const key = `${locationNumber}:${antennaNumber}`;
      let entry = antennas.get(key);
      if (!entry) {
        entry = { antennaNumber, frequencies: [] };
        antennas.set(key, entry);
        location(locationNumber).antennas.push(entry);
      }
      return entry;
    };

    const inRange = 'usi = ? AND location_number BETWEEN ? AND ?';
    const rangeArgs = [row.usi, range.first, range.last];
    const sites = Map.groupBy(
      db
        .prepare<LocationRow>(
          `SELECT * FROM locations WHERE ${inRange} ORDER BY location_number, site_seq`,
        )
        .all(...rangeArgs),
      (lo) => lo.location_number,
    );
    for (const [locationNumber, filedSites] of sites) {
      const [only] = filedSites;
      locations.set(locationNumber, {
        locationNumber,
        ...(filedSites.length > 1
          ? { sites: filedSites.map((lo) => siteFields(lo, siteAddressVisible)) }
          : only && siteFields(only, siteAddressVisible)),
        antennas: [],
      });
    }
    // Grouped by the antenna entry itself: one group per (location, antenna) number pair.
    const filed = Map.groupBy(
      db
        .prepare<AntennaRow>(
          `SELECT * FROM antennas WHERE ${inRange} ORDER BY location_number, antenna_number`,
        )
        .all(...rangeArgs),
      (an) => antenna(an.location_number, an.antenna_number),
    );
    for (const [entry, records] of filed) {
      const agreed = <K extends keyof AntennaRow>(column: K) => {
        const values = new Set(records.map((an) => an[column]));
        return values.size === 1 ? [...values][0] : undefined;
      };
      Object.assign(entry, {
        ...opt('antennaTypeCode', agreed('antenna_type')),
        ...opt('heightToTipM', agreed('height_to_tip_m')),
        ...opt('heightToCenterM', agreed('height_to_center_m')),
        ...opt('haatM', agreed('haat_m')),
        ...opt('azimuthDeg', agreed('azimuth_deg')),
        ...opt('gainDbi', agreed('gain_dbi')),
        ...opt('beamwidthDeg', agreed('beamwidth_deg')),
        ...opt('polarization', agreed('polarization')),
        ...opt('make', agreed('make')),
        ...opt('model', agreed('model')),
        ...(records.length > 1 && { recordCount: records.length }),
      });
    }
    const frequencies = db
      .prepare<FrequencyRow>(
        `SELECT * FROM frequencies WHERE ${inRange} AND frequency_mhz IS NOT NULL
         ORDER BY location_number, antenna_number, freq_seq_id LIMIT ?`,
      )
      .all(...rangeArgs, maxFrequencies);
    for (const fr of frequencies) {
      antenna(fr.location_number, fr.antenna_number).frequencies.push({
        frequencyMhz: fr.frequency_mhz,
        ...opt('upperMhz', fr.upper_mhz),
        ...opt('bandwidthMhz', fr.bandwidth_mhz),
        ...opt('stationClass', fr.class_station),
        ...opt('powerOutputW', fr.power_output_w),
        ...opt('erpW', fr.erp_w),
        ...opt('eirpDbm', fr.eirp_dbm),
        ...opt('transmitterMake', fr.transmitter_make),
        ...opt('transmitterModel', fr.transmitter_model),
        emissions: fr.emissions?.split(',') ?? [],
      });
    }
    const sorted = [...locations.values()].sort((a, b) => a.locationNumber - b.locationNumber);
    for (const entry of sorted) entry.antennas.sort((a, b) => a.antennaNumber - b.antennaNumber);
    return { locations: sorted, shown: frequencies.length };
  }

  // --- find_transmitters ----------------------------------------------------------------

  /**
   * Transmitter sites within `radiusKm` of a point, nearest first: a bounding-box query on
   * `locations(lat, lon)`, then haversine distance in JS, keyset-paginated on
   * `(distance, usi, location_number, site_seq)`. With a band, only sites authorized on an
   * overlapping frequency match, and each site lists only its overlapping frequencies.
   * Frequencies are filed against a location number, so every site sharing one lists the
   * number's frequencies and carries `sitesSharingNumber`.
   */
  async findTransmitters(params: FindTransmittersParams): Promise<PageResult<TransmitterSite>> {
    const { db, id } = await this.requireGeneration();
    let after: CursorKey | undefined;
    if (params.cursor) {
      const key = decodeCursor(params.cursor, id, 't', ['number', 'number', 'number', 'number']);
      if (!key) return { ok: false, reason: 'invalid_cursor' };
      after = key as CursorKey;
    }
    const box = boundingBox(params.latitude, params.longitude, params.radiusKm);
    const statuses = liveStatuses(params.status);
    const where = [
      'lo.lat BETWEEN ? AND ?',
      `(${box.lon.map(() => 'lo.lon BETWEEN ? AND ?').join(' OR ')})`,
      `l.license_status IN (${statuses.map(() => '?').join(', ')})`,
    ];
    const args: SqlValue[] = [...box.lat, ...box.lon.flat(), ...statuses];
    if (params.radioService) {
      where.push('l.radio_service_code = ?');
      args.push(params.radioService);
    }
    const overlap = params.band && this.overlapArgs(params.band);
    if (overlap) {
      where.push(
        `EXISTS (SELECT 1 FROM frequencies f WHERE f.usi = lo.usi
           AND f.location_number = lo.location_number AND f.occ_low <= ? AND f.occ_high >= ?)`,
      );
      args.push(overlap.high, overlap.low);
    }
    const candidates = db
      .prepare<{ lat: number; loc: number; lon: number; seq: number; usi: number }>(
        `SELECT lo.usi, lo.location_number AS loc, lo.site_seq AS seq, lo.lat, lo.lon
         FROM locations lo JOIN licenses l ON l.usi = lo.usi WHERE ${where.join(' AND ')}`,
      )
      .all(...args);

    const siteKey = (site: { distance: number; loc: number; seq: number; usi: number }) => [
      site.distance,
      site.usi,
      site.loc,
      site.seq,
    ];
    const inRange = candidates
      .map((site) => ({
        ...site,
        distance: haversineKm(params.latitude, params.longitude, site.lat, site.lon),
      }))
      .filter((site) => site.distance <= params.radiusKm)
      .sort((a, b) => compareKeys(siteKey(a), siteKey(b)));
    const remaining = after
      ? inRange.filter((site) => compareKeys(siteKey(site), after) > 0)
      : inRange;
    const page = remaining.slice(0, params.limit);
    const last = page.at(-1);

    const siteQuery = db.prepare<LocationRow & LicenseHeadRow & { sites: number }>(
      `SELECT lo.*, ${LICENSE_HEAD_COLUMNS},
         (SELECT count(*) FROM locations s
          WHERE s.usi = lo.usi AND s.location_number = lo.location_number) AS sites
       FROM locations lo JOIN licenses l ON l.usi = lo.usi
       WHERE lo.usi = ? AND lo.location_number = ? AND lo.site_seq = ?`,
    );
    const frequencyQuery = db.prepare<FrequencyRow>(
      `SELECT * FROM frequencies WHERE usi = ? AND location_number = ? AND frequency_mhz IS NOT NULL
       ${overlap ? 'AND occ_low <= ? AND occ_high >= ?' : ''}
       ORDER BY frequency_mhz, upper_mhz`,
    );
    const rows = page.flatMap((candidate): TransmitterSite[] => {
      const site = siteQuery.get(candidate.usi, candidate.loc, candidate.seq);
      if (!site) return [];
      const frequencies = collapseFrequencies(
        frequencyQuery.all(
          candidate.usi,
          candidate.loc,
          ...(overlap ? [overlap.high, overlap.low] : []),
        ),
      );
      const shownFrequencies = frequencies.slice(0, params.maxFrequenciesPerSite);
      return [
        {
          ...this.siteHead(site),
          locationNumber: site.location_number,
          ...opt('locationTypeCode', site.location_type),
          distanceKm: Math.round(candidate.distance * 1000) / 1000,
          latitude: candidate.lat,
          longitude: candidate.lon,
          ...opt('groundElevationM', site.ground_elevation_m),
          ...opt('overallHeightM', site.overall_height_m),
          ...opt('asrNumber', site.asr_number),
          ...opt('county', site.county),
          ...opt('state', site.site_state),
          ...(site.site_state !== null && { stateFromCoordinates: site.state_derived === 1 }),
          ...(site.sites > 1 && { sitesSharingNumber: site.sites }),
          frequencyCount: frequencies.length,
          frequenciesShown: shownFrequencies.length,
          frequencies: shownFrequencies,
        },
      ];
    });
    return {
      ok: true,
      rows,
      total: inRange.length,
      ...(remaining.length > params.limit &&
        last && { nextCursor: encodeCursor(id, 't', siteKey(last)) }),
    };
  }

  // --- search_frequencies ---------------------------------------------------------------

  /**
   * Authorizations whose occupied band overlaps `band`: collapsed site assignments and
   * market blocks (collapsed across partition areas), merged in frequency order and
   * keyset-paginated on `(frequency, kind, usi, location_number or 0, upper edge ?? 0)`.
   * Each band class is scanned from the query's low edge minus that class's widest band
   * ({@link bandScan}), so a lookup reads only rows that can overlap it. A
   * frequency filed against a location number several sites share is one row carrying
   * `sitesSharingNumber` in place of a site's coordinates and place.
   */
  async searchFrequencies(
    params: SearchFrequenciesParams,
  ): Promise<PageResult<FrequencyAssignment>> {
    const { db, id } = await this.requireGeneration();
    let after: CursorKey | undefined;
    if (params.cursor) {
      const key = decodeCursor(params.cursor, id, 'f', [
        'number',
        'number',
        'number',
        'number',
        'number',
      ]);
      if (!key) return { ok: false, reason: 'invalid_cursor' };
      after = key as CursorKey;
    }
    const match = params.licensee === undefined ? undefined : ftsQuery(params.licensee);
    if (params.licensee !== undefined && !match) return { ok: true, rows: [], total: 0 };

    const licenseWhere: string[] = [];
    const licenseArgs: SqlValue[] = [];
    const statuses = liveStatuses(params.status);
    licenseWhere.push(`l.license_status IN (${statuses.map(() => '?').join(', ')})`);
    licenseArgs.push(...statuses);
    if (params.radioService) {
      licenseWhere.push('l.radio_service_code = ?');
      licenseArgs.push(params.radioService);
    }
    if (match) {
      licenseWhere.push('l.usi IN (SELECT rowid FROM licenses_fts WHERE licenses_fts MATCH ?)');
      licenseArgs.push(match);
      if (this.redactIndividuals) licenseWhere.push('l.is_individual = 0');
    }

    const fetch = params.limit + 1;
    const sites =
      params.kind === 'market'
        ? { rows: [], total: 0 }
        : this.siteAssignments(db, params, licenseWhere, licenseArgs, after, fetch);
    const markets =
      params.kind === 'site'
        ? { rows: [], total: 0 }
        : this.marketAssignments(db, params, licenseWhere, licenseArgs, after, fetch);

    const merged = [...sites.rows, ...markets.rows].sort((a, b) => compareKeys(a.key, b.key));
    const page = merged.slice(0, params.limit);
    const last = page.at(-1);
    return {
      ok: true,
      rows: page.map((entry) => entry.row),
      total: sites.total + markets.total,
      ...(merged.length > params.limit && last && { nextCursor: encodeCursor(id, 'f', last.key) }),
    };
  }

  private siteAssignments(
    db: SqliteHandle,
    params: SearchFrequenciesParams,
    licenseWhere: string[],
    licenseArgs: SqlValue[],
    after: CursorKey | undefined,
    fetch: number,
  ): { rows: { key: CursorKey; row: FrequencyAssignment }[]; total: number } {
    const overlap = this.overlapArgs(params.band);
    const scan = bandScan('f', 'occ_low', overlap, readMetaNumber(db, META_KEYS.maxSiteBand));
    const where = [
      'f.occ_low <= ?',
      'f.occ_high >= ?',
      scan.sql,
      'f.frequency_mhz IS NOT NULL',
      ...licenseWhere,
    ];
    const args: SqlValue[] = [overlap.high, overlap.low, ...scan.args, ...licenseArgs];
    if (params.state) {
      where.push('lo.site_state = ?');
      args.push(params.state);
    }
    const from = `FROM frequencies f JOIN licenses l ON l.usi = f.usi
      ${params.state ? 'JOIN' : 'LEFT JOIN'} locations lo
        ON lo.usi = f.usi AND lo.location_number = f.location_number`;
    const group = 'GROUP BY f.frequency_mhz, f.usi, f.location_number, f.upper_mhz';
    const total =
      db
        .prepare<{ n: number }>(
          `SELECT count(*) AS n FROM (SELECT 1 ${from} WHERE ${where.join(' AND ')} ${group})`,
        )
        .get(...args)?.n ?? 0;

    const pageWhere = [...where];
    const pageArgs = [...args];
    if (after) {
      pageWhere.push(
        'f.frequency_mhz >= ?',
        '(f.frequency_mhz, 1, f.usi, f.location_number, COALESCE(f.upper_mhz, 0)) > (?, ?, ?, ?, ?)',
      );
      pageArgs.push(after[0] ?? 0, ...after);
    }
    const rows = db
      .prepare<
        LicenseHeadRow & {
          bandwidth: number | null;
          classes: string | null;
          county: string | null;
          emissions: string | null;
          frequency: number;
          lat: number | null;
          location_number: number;
          lon: number | null;
          max_erp: number | null;
          site_state: string | null;
          sites: number;
          state_derived: number | null;
          upper: number | null;
        }
      >(
        `SELECT ${LICENSE_HEAD_COLUMNS}, f.location_number, f.frequency_mhz AS frequency,
           f.upper_mhz AS upper, max(f.bandwidth_mhz) AS bandwidth,
           group_concat(f.class_station, '|') AS classes, max(f.erp_w) AS max_erp,
           group_concat(f.emissions, ',') AS emissions,
           lo.lat, lo.lon, lo.county, lo.site_state, lo.state_derived,
           (SELECT count(*) FROM locations s
            WHERE s.usi = f.usi AND s.location_number = f.location_number) AS sites
         ${from} WHERE ${pageWhere.join(' AND ')} ${group}
         ORDER BY f.frequency_mhz, f.usi, f.location_number, COALESCE(f.upper_mhz, 0)
         LIMIT ?`,
      )
      .all(...pageArgs, fetch);
    return {
      total,
      rows: rows.map((row) => ({
        key: [row.frequency, 1, row.usi, row.location_number, row.upper ?? 0],
        row: {
          kind: 'site',
          ...this.siteHead(row),
          frequencyMhz: row.frequency,
          ...opt('upperMhz', row.upper),
          ...opt('bandwidthMhz', row.bandwidth),
          stationClasses: [...new Set(row.classes?.split('|') ?? [])],
          ...opt('maxErpW', row.max_erp),
          emissions: [...new Set(row.emissions?.split(',').filter(Boolean) ?? [])],
          locationNumber: row.location_number,
          ...(row.sites > 1
            ? { sitesSharingNumber: row.sites }
            : {
                ...opt('latitude', row.lat),
                ...opt('longitude', row.lon),
                ...opt('county', row.county),
                ...opt('state', row.site_state),
                ...(row.site_state !== null && { stateFromCoordinates: row.state_derived === 1 }),
              }),
        },
      })),
    };
  }

  private marketAssignments(
    db: SqliteHandle,
    params: SearchFrequenciesParams,
    licenseWhere: string[],
    licenseArgs: SqlValue[],
    after: CursorKey | undefined,
    fetch: number,
  ): { rows: { key: CursorKey; row: FrequencyAssignment }[]; total: number } {
    const overlap = this.overlapArgs(params.band);
    const scan = bandScan('mb', 'lower', overlap, readMetaNumber(db, META_KEYS.maxMarketBand));
    const where = [
      'mb.lower <= ?',
      'mb.lower > 0',
      'COALESCE(mb.upper, mb.lower) >= ?',
      scan.sql,
      ...licenseWhere,
    ];
    const args: SqlValue[] = [overlap.high, overlap.low, ...scan.args, ...licenseArgs];
    if (params.state) {
      where.push('l.market_states LIKE ?');
      args.push(`%,${params.state},%`);
    }
    const from = 'FROM market_blocks mb JOIN licenses l ON l.usi = mb.usi';
    const group = 'GROUP BY mb.usi, mb.lower, mb.upper';
    const total =
      db
        .prepare<{ n: number }>(
          `SELECT count(*) AS n FROM (SELECT 1 ${from} WHERE ${where.join(' AND ')} ${group})`,
        )
        .get(...args)?.n ?? 0;

    const pageWhere = [...where];
    const pageArgs = [...args];
    if (after) {
      pageWhere.push(
        'mb.lower >= ?',
        '(mb.lower, 0, mb.usi, 0, COALESCE(mb.upper, 0)) > (?, ?, ?, ?, ?)',
      );
      pageArgs.push(after[0] ?? 0, ...after);
    }
    const rows = db
      .prepare<
        LicenseHeadRow & {
          channel_block: string | null;
          lower: number;
          market_code: string | null;
          market_name: string | null;
          partitions: string | null;
          upper: number | null;
        }
      >(
        `SELECT ${LICENSE_HEAD_COLUMNS}, l.market_code, l.market_name, l.channel_block,
           mb.lower, mb.upper, ${PARTITION_AREAS_SQL} AS partitions
         ${from} WHERE ${pageWhere.join(' AND ')} ${group}
         ORDER BY mb.lower, mb.usi, COALESCE(mb.upper, 0) LIMIT ?`,
      )
      .all(...pageArgs, fetch);
    return {
      total,
      rows: rows.map((row) => ({
        key: [row.lower, 0, row.usi, 0, row.upper ?? 0],
        row: {
          kind: 'market',
          ...this.siteHead(row),
          frequencyMhz: row.lower,
          ...opt('upperMhz', row.upper),
          ...opt('marketCode', row.market_code),
          ...opt('marketName', row.market_name),
          ...opt('channelBlock', row.channel_block),
          ...opt('partitionAreaIds', partitionAreaIds(row.partitions)),
        },
      })),
    };
  }

  // --- Shared ---------------------------------------------------------------------------

  /** The overlap test's bounds: a row overlaps when `occ_low ≤ high` and `occ_high ≥ low`. */
  private overlapArgs(band: Band): { high: number; low: number } {
    return { low: band.lowMhz - OVERLAP_EPSILON_MHZ, high: band.highMhz + OVERLAP_EPSILON_MHZ };
  }

  /** License fields shared by site and assignment rows, redaction applied. */
  private siteHead(row: LicenseHeadRow): {
    callsign?: string;
    isLease: boolean;
    licenseStatus: string;
    licenseeName: string | null;
    licenseeRedacted: boolean;
    radioServiceCode: string;
    radioServiceLabel: string;
    usi: string;
  } {
    const shown = this.redact(row);
    return {
      usi: String(row.usi),
      ...opt('callsign', row.callsign),
      isLease: row.is_lease === 1,
      licenseStatus: row.license_status,
      radioServiceCode: row.radio_service_code,
      radioServiceLabel: radioServiceLabel(row.radio_service_code),
      licenseeName: shown.licenseeName,
      licenseeRedacted: shown.licenseeRedacted,
    };
  }

  /**
   * The redaction chokepoint. While redaction is on, an individual's record loses its
   * licensee name and city (flagged `licenseeRedacted`) and its sites' street addresses,
   * and every trustee name is withheld (`null`) — a trustee is always a person.
   */
  private redact(
    row: Pick<LicenseRow, 'is_individual' | 'licensee_name'> &
      Partial<Pick<LicenseRow, 'licensee_city' | 'trustee_name'>>,
  ): LicenseeFields & {
    licenseeCity: string | null;
    siteAddressVisible: boolean;
    trusteeName: string | null;
  } {
    const individual = this.redactIndividuals && row.is_individual === 1;
    return {
      licenseeName: individual ? null : row.licensee_name,
      licenseeRedacted: individual,
      licenseeCity: individual ? null : (row.licensee_city ?? null),
      siteAddressVisible: !individual,
      trusteeName: this.redactIndividuals ? null : (row.trustee_name ?? null),
    };
  }

  /** The published generation, or a `ServiceUnavailable` carrying `reason: index_not_ready`. */
  private async requireGeneration(): Promise<OpenGeneration> {
    const generation = await this.generation();
    if (!generation?.ready) {
      throw serviceUnavailable(
        this.pointerProblem ??
          'The local ULS index has not been built yet; an operator must run the mirror:init script once.',
        { reason: 'index_not_ready' },
      );
    }
    return generation;
  }

  /**
   * The published generation, re-reading `current.json` at most once per `pointerCheckMs`.
   * When the pointer names a new generation, the new one is opened, swapped in, and the old
   * handle closed. Every query runs synchronously once it holds the handle, so a swap never
   * closes a handle mid-query. A failure to read the pointer or open the generation reaches
   * callers through {@link unreadable}.
   */
  private generation(): Promise<OpenGeneration | undefined> {
    if (this.now() - this.lastPointerCheck < this.pointerCheckMs) {
      return Promise.resolve(this.current);
    }
    this.pendingCheck ??= this.syncPointer()
      .catch((err: unknown) => {
        throw this.unreadable(err);
      })
      .finally(() => {
        this.pendingCheck = undefined;
      });
    return this.pendingCheck;
  }

  /**
   * A failure reading the index as callers see it: a `ServiceUnavailable` whose message has
   * the mirror path taken out, carrying neither the original's `data` (a store open error
   * puts the path there) nor it as `cause` (the framework forwards a cause's message to the
   * client as `rootCause`). The original, path included, goes to the operator log.
   */
  private unreadable(err: unknown): McpError {
    const original = err instanceof Error ? err : new Error(String(err));
    logger.error(
      'Could not read the published ULS index generation.',
      original,
      requestContextService.createRequestContext({
        operation: 'UlsIndexService.syncPointer',
        additionalContext: { mirrorDir: this.mirrorDir },
      }),
    );
    return serviceUnavailable(
      `The local ULS index could not be read: ${this.callerSafe(original.message)}`,
    );
  }

  private async syncPointer(): Promise<OpenGeneration | undefined> {
    this.lastPointerCheck = this.now();
    const pointerPath = join(this.mirrorDir, POINTER_FILE);
    let mtime: number | undefined;
    try {
      mtime = (await stat(pointerPath)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (mtime === this.pointerMtime) return this.current;
    let pointer: GenerationPointer | undefined;
    let problem: string | undefined;
    try {
      pointer = mtime === undefined ? undefined : await readPointer(this.mirrorDir);
    } catch (err) {
      if (!isMalformedPointer(err)) throw err;
      problem = (err as Error).message;
      // The path goes to the operator's log only; callers see the path-free message.
      logger.warning(
        'current.json is not a valid generation pointer; no index generation is served until mirror:init republishes it.',
        requestContextService.createRequestContext({
          operation: 'UlsIndexService.syncPointer',
          additionalContext: { pointerPath },
        }),
      );
    }
    if (pointer?.file === this.current?.file && this.current) {
      this.current.publishedAt = pointer?.publishedAt ?? this.current.publishedAt;
      this.pointerMtime = mtime;
      return this.current;
    }
    // A pointer naming a missing file is re-checked on every pointer check; a malformed one
    // only once it is rewritten, so its warning is logged once.
    const missingFile =
      pointer && !existsSync(join(this.mirrorDir, pointer.file)) ? pointer.file : undefined;
    if (missingFile) {
      problem = `current.json names ${missingFile}, which is missing from the mirror directory; run mirror:init to rebuild the index.`;
    }
    const next = pointer && !missingFile ? await this.open(pointer) : undefined;
    const previous = this.current;
    this.current = next;
    this.pointerProblem = problem;
    this.pointerMtime = missingFile ? undefined : mtime;
    await previous?.store.close();
    return next;
  }

  /**
   * `text` with the mirror directory's filesystem path taken out: paths under it become
   * relative, and the directory itself is named generically. The sync runner stores a failed
   * run's message verbatim, and zip, counts, and fs errors name the files they touched.
   */
  private callerSafe(text: string | undefined): string | undefined {
    return text
      ?.replaceAll(`${this.mirrorDir}${sep}`, '')
      .replaceAll(this.mirrorDir, 'the mirror directory');
  }

  private async open(pointer: GenerationPointer): Promise<OpenGeneration> {
    const store = createUlsStore(join(this.mirrorDir, pointer.file));
    try {
      const db = await store.raw();
      const state = await store.readState();
      return {
        store,
        db,
        file: pointer.file,
        id: pointer.file.slice(GENERATION_PREFIX.length).replace(/\.db$/, ''),
        publishedAt: pointer.publishedAt,
        ready: Boolean(state.completedAt),
      };
    } catch (err) {
      await store.close();
      throw err;
    }
  }

  /**
   * Error of the newest unpublished generation's failed build, when no build is running,
   * with the mirror directory's path taken out.
   */
  private async failedBuildError(): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(this.mirrorDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const newest = names.filter(isGenerationFile).sort().at(-1);
    if (!newest) return;
    const store = createUlsStore(join(this.mirrorDir, newest));
    try {
      const state = await store.readState();
      return state.status === 'error' ? this.callerSafe(state.error) : undefined;
    } finally {
      await store.close();
    }
  }

  /** Close the open generation. */
  async close(): Promise<void> {
    const previous = this.current;
    this.current = undefined;
    this.pointerProblem = undefined;
    this.pointerMtime = undefined;
    this.lastPointerCheck = Number.NEGATIVE_INFINITY;
    await previous?.store.close();
  }
}

function readDataAsOf(db: SqliteHandle): string | undefined {
  return (
    db
      .prepare<{ latest: string | null }>('SELECT max(counts_created) AS latest FROM ingest_files')
      .get()?.latest ?? undefined
  );
}

/**
 * The daily files applied to a generation, as `<count>.<latest applied_at>`. Each file is
 * applied in one transaction with its `ingest_files` row, so this changes with every refresh
 * that changes rows, a re-applied file included.
 */
function readRefreshState(db: SqliteHandle): string {
  const state = db
    .prepare<{ applied: number; latest: string | null }>(
      "SELECT count(*) AS applied, max(applied_at) AS latest FROM ingest_files WHERE kind = 'daily'",
    )
    .get();
  return `${state?.applied ?? 0}.${state?.latest ?? ''}`;
}

/**
 * The overlap test's lower-edge range scan as one index range per band class: a row of class
 * `c` that overlaps `[low, high]` has its lower edge in `[low − bound(c), high]`
 * ({@link bandClassBounds}), so a narrow lookup never reads rows only a wide filing could
 * reach. `widest` is the table's stored widest band, which bounds the open class. Callers put
 * the overlap test itself ahead of it, so a plan that reaches rows by license or state checks
 * that before the per-class ranges.
 */
function bandScan(
  alias: string,
  lowerEdge: string,
  overlap: { high: number; low: number },
  widest: number,
): { args: SqlValue[]; sql: string } {
  const bounds = bandClassBounds(widest);
  const range = `(${alias}.band_class = ? AND ${alias}.${lowerEdge} BETWEEN ? AND ?)`;
  return {
    sql: `(${bounds.map(() => range).join(' OR ')})`,
    args: bounds.flatMap(([bandClass, bound]) => [bandClass, overlap.low - bound, overlap.high]),
  };
}

/**
 * A numeric `meta` value. Missing is an error, never 0: the band bounds limit the overlap
 * range scans, and a wrong bound would silently drop matches.
 */
function readMetaNumber(db: SqliteHandle, key: string): number {
  const value = Number(
    db.prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?').get(key)?.value,
  );
  if (!Number.isFinite(value)) {
    throw internalError(`The index is missing its ${key} summary; rerun mirror:init.`, { key });
  }
  return value;
}

function readGroupStats(db: SqliteHandle): GroupStats {
  const value = db
    .prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?')
    .get(META_KEYS.groupStats)?.value;
  return value ? (JSON.parse(value) as GroupStats) : {};
}

// --- Init/accessor --------------------------------------------------------------------

let _service: UlsIndexService | undefined;

/** Create the index service; called once from `createApp`'s `setup()`. */
export function initUlsIndexService(options: UlsIndexServiceOptions): UlsIndexService {
  _service = new UlsIndexService(options);
  return _service;
}

/** The index service. Throws when `initUlsIndexService()` has not run. */
export function getUlsIndexService(): UlsIndexService {
  if (!_service) {
    throw new Error('UlsIndexService not initialized — call initUlsIndexService() in setup()');
  }
  return _service;
}
