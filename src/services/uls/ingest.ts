/**
 * @fileoverview `UlsIngester` — builds and refreshes the ULS index. The weekly rebuild
 * (`rebuild`) downloads each selected service group's snapshot into a fresh generation
 * file, one resumable `<group>:download|records|technical` step at a time, then
 * publishes it through `current.json`. The daily refresh (`refresh`) applies the
 * `daily/l_*.zip` incrementals to the published generation by replacing every record
 * set they carry, keyed by USI. All row writes go through the store's raw handle in
 * explicit transactions; the MirrorService keeps the sync state, schema, FTS, and
 * readiness.
 * @module services/uls/ingest
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { conflict, serializationError } from '@cyanheads/mcp-ts-core/errors';
import {
  defineMirror,
  type Mirror,
  type MirrorLogger,
  type MirrorStore,
  type SqliteHandle,
  type SqliteStatement,
  type SqlValue,
  type SyncContext,
  type SyncPage,
  type SyncResult,
} from '@cyanheads/mcp-ts-core/mirror';
import {
  dailyZipPath,
  type UlsDownload,
  type UlsRemoteFile,
  weeklyZipPath,
} from './bulk-client.js';
import { type ServiceGroup, USPS_STATES } from './codes.js';
import {
  type CountsFile,
  decodeAm,
  decodeAn,
  decodeEm,
  decodeEn,
  decodeFr,
  decodeHd,
  decodeLl,
  decodeLo,
  decodeMf,
  decodeMk,
  emissionBandwidthMhz,
  MAX_FRACTIONAL_BANDWIDTH,
  parseCountsFile,
  type RecordType,
  toIsoSeconds,
} from './dat.js';
import {
  compactStamp,
  createUlsStore,
  type GenerationPointer,
  type GroupStats,
  generationFileName,
  INDIVIDUAL_BY_DEFAULT_SERVICES,
  type IngestStage,
  isGenerationFile,
  isMalformedPointer,
  isProcessAlive,
  LEASE_CALLSIGN,
  LIVE_STATUSES,
  LOCK_FILE,
  META_KEYS,
  MIRROR_NAME,
  POINTER_FILE,
  type RecordStats,
  readIngestLock,
  readPointer,
  writePointer,
} from './schema.js';
import { stateAt } from './state-lookup.js';
import { openZipArchive, type ZipArchive } from './zip-reader.js';

/** The slice of `UlsBulkClient` the ingester uses; tests pass a fake. */
export interface IngestClient {
  download(path: string, destination: string, signal?: AbortSignal): Promise<UlsDownload>;
  head(path: string, signal?: AbortSignal): Promise<UlsRemoteFile | null>;
  listDailyFiles(signal?: AbortSignal): Promise<string[]>;
}

/** Constructor options. `client`, `openArchive`, `tempDir`, and `now` are the test seams. */
export interface UlsIngesterOptions {
  client: IngestClient;
  logger?: MirrorLogger;
  /** Directory holding generation files, `current.json`, and the ingest lock. */
  mirrorDir: string;
  now?: () => number;
  openArchive?: (path: string) => Promise<ZipArchive>;
  /** Weekly service groups to index, in build order. */
  services: readonly ServiceGroup[];
  /** Where downloaded zips wait for their steps; defaults to `<mirrorDir>/tmp`. */
  tempDir?: string;
}

/** Outcome of {@link UlsIngester.rebuild}. */
export interface RebuildResult {
  /** The published generation file after the call. */
  generation: string;
  /** Runner totals when a rebuild ran. */
  result?: SyncResult;
  /** `skipped` when no selected snapshot is newer than the published generation. */
  status: 'rebuilt' | 'skipped';
}

/** Outcome of {@link UlsIngester.refresh}. */
export interface RefreshResult {
  /** Daily files applied, oldest first. */
  applied: string[];
  generation: string;
  result: SyncResult;
}

/** A daily refresh only trusts the seven-day window when the checkpoint is at most six days old. */
const MAX_CHECKPOINT_AGE_MS = 6 * 24 * 60 * 60 * 1000;

/** Rows per staging transaction. */
const STAGE_BATCH = 20_000;

const LIVE_SQL = LIVE_STATUSES.map((status) => `'${status}'`).join(', ');
const INDIVIDUAL_SQL = INDIVIDUAL_BY_DEFAULT_SERVICES.map((code) => `'${code}'`).join(', ');

/** Row of `ingest_files`. */
interface IngestFileRow {
  counts_created: string;
  counts_json: string;
  kind: 'weekly' | 'daily';
  last_modified: string;
  path: string;
  service_group: string | null;
  size_bytes: number | null;
  stage: IngestStage;
  stats_json: string;
}

const NEVER_ABORT = new AbortController().signal;

/**
 * State codes named in a market name — the text after its last comma, split on `-` and
 * `/` (`Fargo-Moorhead, ND-MN` → `,ND,MN,`). `null` when the name has no comma or no
 * recognizable code (a nationwide market, or a name cut before its state).
 */
export function marketStates(marketName: string | null): string | null {
  if (!marketName) return null;
  const comma = marketName.lastIndexOf(',');
  if (comma === -1) return null;
  const codes = marketName
    .slice(comma + 1)
    .split(/[-/]/)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => Object.hasOwn(USPS_STATES, part));
  return codes.length ? `,${[...new Set(codes)].join(',')},` : null;
}

/** Builds (weekly) and refreshes (daily) the ULS index generations. */
export class UlsIngester {
  private readonly client: IngestClient;
  private readonly logger: MirrorLogger;
  private readonly mirrorDir: string;
  private readonly now: () => number;
  private readonly openArchive: (path: string) => Promise<ZipArchive>;
  private readonly services: readonly ServiceGroup[];
  private readonly tempDir: string;

  constructor(options: UlsIngesterOptions) {
    this.client = options.client;
    this.logger = options.logger ?? {};
    this.mirrorDir = options.mirrorDir;
    this.now = options.now ?? Date.now;
    this.openArchive = options.openArchive ?? openZipArchive;
    this.services = options.services;
    this.tempDir = options.tempDir ?? join(options.mirrorDir, 'tmp');
  }

  /**
   * Weekly rebuild. Skips when every selected group's snapshot `Last-Modified` matches the
   * published generation's; otherwise builds (or resumes) the target generation named from
   * the earliest snapshot `Last-Modified`, publishes it, and returns. A failed build leaves
   * the published generation untouched; rerunning resumes from the last completed step. A
   * malformed `current.json` counts as no published generation, so the rebuild replaces it.
   */
  async rebuild(signal: AbortSignal = NEVER_ABORT): Promise<RebuildResult> {
    await mkdir(this.tempDir, { recursive: true });
    return this.withLock('init', async () => {
      const remote = await this.headWeekly(signal);
      const pointer = await this.publishedPointer();
      if (pointer && !(await this.needsRebuild(pointer, remote))) {
        this.logger.info?.('Every selected snapshot is already indexed; rebuild skipped.', {
          generation: pointer.file,
        });
        return { status: 'skipped', generation: pointer.file };
      }

      const target = targetGeneration(remote, pointer);
      await this.deleteStaleGenerations([target, pointer?.file]);
      if (await this.builtFromOtherSnapshots(target, remote)) {
        this.logger.info?.(
          'Discarding a retired generation built from other snapshots; building it afresh.',
          { generation: target },
        );
        for (const file of generationFiles(target)) {
          await rm(join(this.mirrorDir, file), { force: true });
        }
      }
      this.logger.info?.('Building index generation', {
        generation: target,
        groups: this.services.join(','),
      });

      const store = createUlsStore(join(this.mirrorDir, target));
      const mirror = this.defineMirror(store, (ctx) => this.initPages(ctx, store));
      try {
        const result = await mirror.runSync({ mode: 'init', signal });
        await writePointer(this.mirrorDir, {
          file: target,
          publishedAt: toIsoSeconds(this.now()),
        });
        this.logger.info?.('Published index generation', { generation: target, ...result });
        return { status: 'rebuilt', generation: target, result };
      } finally {
        await mirror.close();
      }
    });
  }

  /**
   * Daily refresh of the published generation: applies every `daily/l_*.zip` whose
   * `Last-Modified` is newer than the checkpoint and not yet applied, oldest first, each in
   * one transaction. Stops at the first failure with the checkpoint at the last applied file.
   */
  async refresh(signal: AbortSignal = NEVER_ABORT): Promise<RefreshResult> {
    await mkdir(this.tempDir, { recursive: true });
    return this.withLock('refresh', async () => {
      const pointer = await readPointer(this.mirrorDir);
      if (!pointer || !existsSync(join(this.mirrorDir, pointer.file))) {
        throw conflict(
          `No published ULS index generation in ${this.mirrorDir}; run mirror:init first.`,
          { mirrorDir: this.mirrorDir },
        );
      }
      const applied: string[] = [];
      const store = createUlsStore(join(this.mirrorDir, pointer.file));
      try {
        const checkpoint = await this.refreshCheckpoint(store);
        const mirror = this.defineMirror(store, (ctx) =>
          this.refreshPages(ctx, store, checkpoint, applied),
        );
        const result = await mirror.runSync({ mode: 'refresh', signal });
        this.logger.info?.('Daily refresh complete', {
          generation: pointer.file,
          applied: applied.length,
        });
        return { generation: pointer.file, applied, result };
      } finally {
        await store.close();
      }
    });
  }

  /**
   * The checkpoint a daily refresh starts from. A missing or stale one fails here, before the
   * sync runner starts, so the stale case the HTTP scheduler handles logs no runner error. The
   * failure is still recorded in the sync state as the runner would record it (the completion
   * marker survives), so `coverage` reports it while the index stays ready.
   */
  private async refreshCheckpoint(store: MirrorStore): Promise<string> {
    const { checkpoint } = await store.readState();
    if (checkpoint && this.now() - Date.parse(checkpoint) <= MAX_CHECKPOINT_AGE_MS) {
      return checkpoint;
    }
    const failure = checkpoint
      ? conflict(
          `The index checkpoint ${checkpoint} is more than six days old, so the seven-day daily window may have rolled past unapplied files; run mirror:init to rebuild the index.`,
          { checkpoint, reason: 'stale_checkpoint' },
        )
      : conflict('The published index has no checkpoint; run mirror:init to rebuild it.');
    await store.writeState({
      status: 'error',
      startedAt: toIsoSeconds(this.now()),
      ...(checkpoint && { checkpoint }),
      error: failure.message,
    });
    throw failure;
  }

  private defineMirror(
    store: MirrorStore,
    sync: (ctx: SyncContext) => AsyncGenerator<SyncPage>,
  ): Mirror {
    return defineMirror({ name: MIRROR_NAME, store, sync, logger: this.logger });
  }

  // --- Weekly rebuild -------------------------------------------------------------------

  /**
   * The published pointer, treating a malformed `current.json` as no pointer: the rebuild
   * is what republishes it, so a bad pointer must not block the one command that repairs it.
   */
  private async publishedPointer(): Promise<GenerationPointer | undefined> {
    try {
      return await readPointer(this.mirrorDir);
    } catch (err) {
      if (!isMalformedPointer(err)) throw err;
      this.logger.warning?.('current.json is malformed; the rebuild republishes it.', {
        pointerPath: join(this.mirrorDir, POINTER_FILE),
      });
      return;
    }
  }

  private async headWeekly(signal: AbortSignal): Promise<Map<ServiceGroup, UlsRemoteFile>> {
    const remote = new Map<ServiceGroup, UlsRemoteFile>();
    for (const group of this.services) {
      const path = weeklyZipPath(group);
      const head = await this.client.head(path, signal);
      if (!head) {
        throw conflict(
          `The ULS bulk host has no weekly snapshot at ${path}; remove "${group}" from FCC_SPECTRUM_SERVICES or retry later.`,
          { path },
        );
      }
      remote.set(group, head);
    }
    return remote;
  }

  /**
   * True when a selected group is missing from the published generation or its snapshot's
   * `Last-Modified` is newer than the one recorded when the generation was built.
   */
  private async needsRebuild(
    pointer: GenerationPointer,
    remote: Map<ServiceGroup, UlsRemoteFile>,
  ): Promise<boolean> {
    const path = join(this.mirrorDir, pointer.file);
    if (!existsSync(path)) return true;
    const recorded = await readWeeklyRows(path);
    return [...remote].some(([group, head]) => {
      const row = recorded.get(weeklyZipPath(group));
      if (row?.stage !== 'complete') return true;
      return head.lastModified > row.last_modified;
    });
  }

  /**
   * True when the target generation file exists and records a weekly snapshot other than the
   * current one for its group, or a group no longer selected. The target alternates between
   * the primary name and its `-2` form, so it can be a retired generation, complete for older
   * snapshots: building into it would skip those groups and publish their stale data. An
   * interrupted build of the current snapshots matches, and resumes.
   */
  private async builtFromOtherSnapshots(
    target: string,
    remote: Map<ServiceGroup, UlsRemoteFile>,
  ): Promise<boolean> {
    const path = join(this.mirrorDir, target);
    if (!existsSync(path)) return false;
    const current = new Map(
      [...remote].map(([group, head]) => [weeklyZipPath(group), head.lastModified]),
    );
    const recorded = await readWeeklyRows(path);
    return [...recorded.values()].some((row) => current.get(row.path) !== row.last_modified);
  }

  /** Delete every generation file (and its WAL sidecars) except the ones named in `keep`. */
  private async deleteStaleGenerations(keep: (string | undefined)[]): Promise<void> {
    const names = await readdir(this.mirrorDir);
    for (const name of names) {
      if (!isGenerationFile(name) || keep.includes(name)) continue;
      for (const file of generationFiles(name)) {
        try {
          await rm(join(this.mirrorDir, file), { force: true });
        } catch (err) {
          this.logger.warning?.(
            'Could not delete a stale index generation; retrying next rebuild.',
            {
              file,
              error: (err as Error).message,
            },
          );
        }
      }
    }
  }

  private async *initPages(ctx: SyncContext, store: MirrorStore): AsyncGenerator<SyncPage> {
    const db = await store.raw();
    configureIngestConnection(db);
    if (ctx.cursor) this.logger.info?.('Resuming index build', { after: ctx.cursor });

    for (const group of this.services) {
      const path = weeklyZipPath(group);
      let row = readIngestRow(db, path);
      if (!row) {
        row = await this.downloadWeekly(db, group, ctx.signal);
        yield { records: [], cursor: `${group}:download` };
      }
      if (row.stage === 'downloaded') {
        row = await this.loadRecords(db, row, group, ctx.signal);
        yield { records: [], cursor: `${group}:records` };
      }
      if (row.stage === 'records') {
        await this.loadTechnical(db, row, group, ctx.signal);
        yield { records: [], cursor: `${group}:technical` };
      }
    }

    recomputeSummaries(db);
    const earliest = db
      .prepare<{ earliest: string | null }>(
        "SELECT min(counts_created) AS earliest FROM ingest_files WHERE kind = 'weekly'",
      )
      .get()?.earliest;
    yield { records: [], ...(earliest && { checkpoint: earliest }) };
  }

  /** `download` step: fetch the snapshot and record it with its `counts` file. */
  private async downloadWeekly(
    db: SqliteHandle,
    group: ServiceGroup,
    signal: AbortSignal,
  ): Promise<IngestFileRow> {
    const path = weeklyZipPath(group);
    const download = await this.client.download(path, this.tempPath(path), signal);
    const counts = await this.readCounts(download.destination);
    const row: IngestFileRow = {
      path,
      kind: 'weekly',
      service_group: group,
      last_modified: download.lastModified,
      counts_created: counts.createdAt,
      size_bytes: download.sizeBytes,
      stage: 'downloaded',
      counts_json: JSON.stringify(counts.counts),
      stats_json: '{}',
    };
    db.transaction(() => upsertIngestRow(db, row, null));
    this.logger.info?.('Downloaded weekly snapshot', {
      path,
      bytes: download.sizeBytes,
      snapshotCreated: counts.createdAt,
    });
    return row;
  }

  /** `records` step: HD, EN (licensee), AM, MK, and LL for every record in the group. */
  private async loadRecords(
    db: SqliteHandle,
    row: IngestFileRow,
    group: ServiceGroup,
    signal: AbortSignal,
  ): Promise<IngestFileRow> {
    const archive = await this.openWeeklyZip(row, signal);
    try {
      const stats = await stageRecords(db, archive, signal);
      const next: IngestFileRow = { ...row, stage: 'records' };
      db.transaction(() => {
        db.exec(
          'DROP TABLE IF EXISTS temp.apply; CREATE TEMP TABLE apply (usi INTEGER PRIMARY KEY, service_group TEXT NOT NULL);',
        );
        db.prepare(
          'INSERT INTO temp.apply (usi, service_group) SELECT usi, ? FROM temp.stage_hd',
        ).run(group);
        const inserted = insertRecords(db);
        setKept(stats, 'HD', inserted);
        next.stats_json = JSON.stringify({ ...parseStats(row.stats_json), ...stats });
        upsertIngestRow(db, next, null);
      });
      dropStaging(db);
      this.logger.info?.('Loaded license records', { group, records: stats.HD?.kept ?? 0 });
      return next;
    } finally {
      await archive.close();
    }
  }

  /** `technical` step: LO, AN, FR, EM, and MF for the group's live licenses. */
  private async loadTechnical(
    db: SqliteHandle,
    row: IngestFileRow,
    group: ServiceGroup,
    signal: AbortSignal,
  ): Promise<void> {
    const archive = await this.openWeeklyZip(row, signal);
    try {
      const live = new Set(
        db
          .prepare<{ usi: number }>(
            `SELECT usi FROM licenses WHERE service_group = ? AND license_status IN (${LIVE_SQL})`,
          )
          .all(group)
          .map((license) => license.usi),
      );
      const stats = await stageTechnical(db, archive, live, signal);
      db.transaction(() => {
        insertTechnical(db, stats);
        upsertIngestRow(
          db,
          {
            ...row,
            stage: 'complete',
            stats_json: JSON.stringify({ ...parseStats(row.stats_json), ...stats }),
          },
          toIsoSeconds(this.now()),
        );
      });
      dropStaging(db);
      this.logger.info?.('Loaded technical records', {
        group,
        liveLicenses: live.size,
        sites: stats.LO?.kept ?? 0,
        frequencies: stats.FR?.kept ?? 0,
      });
    } finally {
      await archive.close();
    }
    await rm(this.tempPath(row.path), { force: true });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Open a group's downloaded snapshot, fetching it again when the temp file is missing or
   * its size differs from the recorded download (a resume after the file was removed).
   */
  private async openWeeklyZip(row: IngestFileRow, signal: AbortSignal): Promise<ZipArchive> {
    const destination = this.tempPath(row.path);
    const size = await stat(destination).then(
      (info) => info.size,
      () => undefined,
    );
    if (size === undefined || size !== row.size_bytes) {
      const download = await this.client.download(row.path, destination, signal);
      if (download.lastModified !== row.last_modified) {
        this.logger.warning?.(
          'The snapshot changed upstream mid-build; later steps read the newer file.',
          { path: row.path, recorded: row.last_modified, fetched: download.lastModified },
        );
      }
    }
    return this.openArchive(destination);
  }

  // --- Daily refresh --------------------------------------------------------------------

  private async *refreshPages(
    ctx: SyncContext,
    store: MirrorStore,
    checkpoint: string,
    applied: string[],
  ): AsyncGenerator<SyncPage> {
    const db = await store.raw();
    configureIngestConnection(db);
    const recorded = readIngestRows(db, 'daily');

    const pending: UlsRemoteFile[] = [];
    for (const name of await this.client.listDailyFiles(ctx.signal)) {
      const path = dailyZipPath(name);
      const head = await this.client.head(path, ctx.signal);
      if (!head || head.lastModified <= checkpoint) continue;
      if (recorded.get(path)?.last_modified === head.lastModified) continue;
      pending.push(head);
    }
    pending.sort(
      (a, b) => a.lastModified.localeCompare(b.lastModified) || a.path.localeCompare(b.path),
    );
    this.logger.info?.('Daily files to apply', { count: pending.length, checkpoint });

    for (const file of pending) {
      const counts = await this.applyDaily(db, file, ctx.signal);
      applied.push(file.path);
      yield { records: [], checkpoint: counts.createdAt };
    }
    recomputeSummaries(db);
  }

  /** Apply one daily file: replace, by USI, every record set it carries. */
  private async applyDaily(
    db: SqliteHandle,
    file: UlsRemoteFile,
    signal: AbortSignal,
  ): Promise<CountsFile> {
    const download = await this.client.download(file.path, this.tempPath(file.path), signal);
    const archive = await this.openArchive(download.destination);
    try {
      const counts = await readCountsFrom(archive, download.destination);
      const stats = await stageRecords(db, archive, signal);
      db.exec(
        `DROP TABLE IF EXISTS temp.apply;
         CREATE TEMP TABLE apply (usi INTEGER PRIMARY KEY, service_group TEXT NOT NULL);
         INSERT INTO temp.apply (usi, service_group)
           SELECT h.usi, COALESCE(l.service_group, sc.service_group)
           FROM temp.stage_hd h
           LEFT JOIN licenses l ON l.usi = h.usi
           LEFT JOIN service_codes sc ON sc.code = h.radio_service_code
           WHERE l.usi IS NOT NULL OR sc.code IS NOT NULL;`,
      );
      const live = new Set(
        db
          .prepare<{ usi: number }>(
            `SELECT h.usi FROM temp.stage_hd h JOIN temp.apply a ON a.usi = h.usi WHERE h.license_status IN (${LIVE_SQL})`,
          )
          .all()
          .map((license) => license.usi),
      );
      Object.assign(stats, await stageTechnical(db, archive, live, signal));

      db.transaction(() => {
        for (const table of ['locations', 'antennas', 'frequencies', 'market_blocks', 'licenses']) {
          db.exec(`DELETE FROM ${table} WHERE usi IN (SELECT usi FROM temp.apply)`);
        }
        db.exec('DELETE FROM lease_links WHERE lease_usi IN (SELECT usi FROM temp.apply)');
        setKept(stats, 'HD', insertRecords(db));
        insertTechnical(db, stats);
        widenBandBounds(db);
        upsertIngestRow(
          db,
          {
            path: file.path,
            kind: 'daily',
            service_group: null,
            last_modified: download.lastModified,
            counts_created: counts.createdAt,
            size_bytes: download.sizeBytes,
            stage: 'complete',
            counts_json: JSON.stringify(counts.counts),
            stats_json: JSON.stringify(stats),
          },
          toIsoSeconds(this.now()),
        );
      });
      dropStaging(db);
      this.logger.info?.('Applied daily file', {
        path: file.path,
        records: stats.HD?.kept ?? 0,
        created: counts.createdAt,
      });
      return counts;
    } finally {
      await archive.close();
      await rm(download.destination, { force: true });
    }
  }

  // --- Shared helpers -------------------------------------------------------------------

  private tempPath(path: string): string {
    return join(this.tempDir, basename(path));
  }

  private async readCounts(zipPath: string): Promise<CountsFile> {
    const archive = await this.openArchive(zipPath);
    try {
      return await readCountsFrom(archive, zipPath);
    } finally {
      await archive.close();
    }
  }

  /** Run `fn` holding the ingest lock; a lock whose recorded PID is dead is reclaimed. */
  private async withLock<T>(mode: 'init' | 'refresh', fn: () => Promise<T>): Promise<T> {
    const lockPath = join(this.mirrorDir, LOCK_FILE);
    const holder = { pid: process.pid, mode, startedAt: toIsoSeconds(this.now()) };
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(lockPath, JSON.stringify(holder), { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
        const current = await readIngestLock(this.mirrorDir);
        if (current && isProcessAlive(current.pid)) {
          throw conflict(
            `Another ULS ingest (${current.mode}, PID ${current.pid}, started ${current.startedAt}) holds ${lockPath}; wait for it to finish.`,
            { lockPath, pid: current.pid, reason: 'ingest_locked' },
          );
        }
        this.logger.warning?.('Reclaiming an ingest lock left by a process that is gone.', {
          lockPath,
          pid: current?.pid,
        });
        await rm(lockPath, { force: true });
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

/**
 * The generation to build: named from the earliest snapshot `Last-Modified`, with a `-2`
 * suffix when that name is the published generation (a group added within the same week),
 * so the file in use is never written. Deterministic, so an interrupted build resumes.
 */
function targetGeneration(
  remote: Map<ServiceGroup, UlsRemoteFile>,
  pointer: GenerationPointer | undefined,
): string {
  const earliest = [...remote.values()].map((file) => file.lastModified).sort()[0];
  if (!earliest) throw conflict('No service group is selected for the index.');
  const stamp = compactStamp(earliest);
  const primary = generationFileName(stamp);
  return primary === pointer?.file ? generationFileName(stamp, '2') : primary;
}

/** A generation database file and its WAL sidecars. */
function generationFiles(name: string): string[] {
  return [name, `${name}-wal`, `${name}-shm`];
}

/** Bulk-load connection settings: fewer fsyncs (WAL keeps the file consistent) and a larger cache. */
function configureIngestConnection(db: SqliteHandle): void {
  db.exec('PRAGMA synchronous = NORMAL; PRAGMA cache_size = -262144;');
}

async function readCountsFrom(archive: ZipArchive, zipPath: string): Promise<CountsFile> {
  const entry = archive.find('counts');
  if (!entry) throw serializationError(`No counts file in ${zipPath}.`, { zipPath });
  return parseCountsFile(await archive.readText(entry));
}

function readIngestRow(db: SqliteHandle, path: string): IngestFileRow | undefined {
  return db.prepare<IngestFileRow>('SELECT * FROM ingest_files WHERE path = ?').get(path);
}

function readIngestRows(db: SqliteHandle, kind: IngestFileRow['kind']): Map<string, IngestFileRow> {
  const rows = db.prepare<IngestFileRow>('SELECT * FROM ingest_files WHERE kind = ?').all(kind);
  return new Map(rows.map((row) => [row.path, row]));
}

/** The weekly `ingest_files` rows of a generation file, read through a short-lived connection. */
async function readWeeklyRows(path: string): Promise<Map<string, IngestFileRow>> {
  const store = createUlsStore(path);
  try {
    return readIngestRows(await store.raw(), 'weekly');
  } finally {
    await store.close();
  }
}

function upsertIngestRow(db: SqliteHandle, row: IngestFileRow, appliedAt: string | null): void {
  db.prepare(
    `INSERT OR REPLACE INTO ingest_files
       (path, kind, service_group, last_modified, counts_created, size_bytes, stage, counts_json, stats_json, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.path,
    row.kind,
    row.service_group,
    row.last_modified,
    row.counts_created,
    row.size_bytes,
    row.stage,
    row.counts_json,
    row.stats_json,
    appliedAt,
  );
}

function parseStats(json: string): RecordStats {
  return JSON.parse(json) as RecordStats;
}

function setKept(stats: RecordStats, type: RecordType, kept: number): void {
  const entry = stats[type];
  if (entry) entry.kept = kept;
}

// --- Staging -----------------------------------------------------------------------------

const RECORD_STAGING_DDL = `
DROP TABLE IF EXISTS temp.stage_hd;
CREATE TEMP TABLE stage_hd (
  usi INTEGER PRIMARY KEY, callsign TEXT, license_status TEXT, radio_service_code TEXT,
  grant_date TEXT, expired_date TEXT, cancellation_date TEXT, effective_date TEXT,
  last_action_date TEXT, is_lease INTEGER NOT NULL
);
DROP TABLE IF EXISTS temp.stage_en;
CREATE TEMP TABLE stage_en (
  usi INTEGER PRIMARY KEY, licensee_name TEXT, licensee_city TEXT, licensee_state TEXT,
  frn TEXT, applicant_type TEXT
);
DROP TABLE IF EXISTS temp.stage_am;
CREATE TEMP TABLE stage_am (
  usi INTEGER PRIMARY KEY, operator_class TEXT, trustee_callsign TEXT, previous_callsign TEXT,
  trustee_name TEXT
);
DROP TABLE IF EXISTS temp.stage_mk;
CREATE TEMP TABLE stage_mk (
  usi INTEGER PRIMARY KEY, market_code TEXT, channel_block TEXT, market_name TEXT,
  market_states TEXT
);
DROP TABLE IF EXISTS temp.stage_ll;
CREATE TEMP TABLE stage_ll (
  lease_usi INTEGER NOT NULL, parent_usi INTEGER NOT NULL, parent_callsign TEXT, lease_id TEXT
);
`;

const TECHNICAL_STAGING_DDL = `
DROP TABLE IF EXISTS temp.stage_lo;
CREATE TEMP TABLE stage_lo AS SELECT * FROM main.locations LIMIT 0;
DROP TABLE IF EXISTS temp.stage_an;
CREATE TEMP TABLE stage_an AS SELECT * FROM main.antennas LIMIT 0;
DROP TABLE IF EXISTS temp.stage_fr;
CREATE TEMP TABLE stage_fr (
  usi INTEGER, location_number INTEGER, antenna_number INTEGER, freq_seq_id INTEGER,
  class_station TEXT, frequency_mhz REAL, upper_mhz REAL, power_output_w REAL, erp_w REAL,
  eirp_dbm REAL, transmitter_make TEXT, transmitter_model TEXT
);
DROP TABLE IF EXISTS temp.stage_em;
CREATE TEMP TABLE stage_em (
  usi INTEGER, location_number INTEGER, antenna_number INTEGER, freq_seq_id INTEGER,
  emission_code TEXT, bandwidth_mhz REAL
);
DROP TABLE IF EXISTS temp.stage_mf;
CREATE TEMP TABLE stage_mf AS SELECT * FROM main.market_blocks LIMIT 0;
`;

const STAGING_TABLES = [
  'stage_hd',
  'stage_en',
  'stage_am',
  'stage_mk',
  'stage_ll',
  'stage_lo',
  'stage_an',
  'stage_fr',
  'stage_em',
  'stage_mf',
  'apply',
];

function dropStaging(db: SqliteHandle): void {
  db.exec(STAGING_TABLES.map((table) => `DROP TABLE IF EXISTS temp.${table};`).join('\n'));
}

/**
 * Stream one record type from the archive into a staging table. `toRow` maps a decoded
 * record to its bound values, or `null` to skip it (a non-licensee entity, a non-live
 * USI). Lines that fail to decode are counted as rejected, never guessed at.
 */
async function stageType<T>(
  db: SqliteHandle,
  archive: ZipArchive,
  type: RecordType,
  decode: (line: string) => T | null,
  toRow: (record: T) => SqlValue[] | null,
  insert: SqliteStatement,
  signal: AbortSignal,
  stats: RecordStats,
): Promise<void> {
  const entry = archive.find(`${type}.dat`);
  if (!entry) return;
  const counts = { read: 0, rejected: 0, kept: 0 };
  stats[type] = counts;
  let batch: SqlValue[][] = [];
  const flush = () => {
    const rows = batch;
    batch = [];
    db.transaction(() => {
      for (const row of rows) insert.run(...row);
    });
  };
  for await (const line of archive.entryLines(entry)) {
    counts.read++;
    const record = decode(line);
    if (!record) {
      counts.rejected++;
      continue;
    }
    const row = toRow(record);
    if (!row) continue;
    counts.kept++;
    batch.push(row);
    if (batch.length >= STAGE_BATCH) {
      flush();
      signal.throwIfAborted();
    }
  }
  flush();
}

/** Stage HD, EN (licensee rows only), AM, MK, and LL. One row per USI in HD/EN/AM/MK; first wins. */
async function stageRecords(
  db: SqliteHandle,
  archive: ZipArchive,
  signal: AbortSignal,
): Promise<RecordStats> {
  db.exec(RECORD_STAGING_DDL);
  const stats: RecordStats = {};
  await stageType(
    db,
    archive,
    'HD',
    // A header without a status or service code cannot be filtered or classified: rejected.
    (line) => {
      const hd = decodeHd(line);
      return hd?.licenseStatus && hd.radioServiceCode ? hd : null;
    },
    (hd) => [
      hd.usi,
      hd.callsign,
      hd.licenseStatus,
      hd.radioServiceCode,
      hd.grantDate,
      hd.expiredDate,
      hd.cancellationDate,
      hd.effectiveDate,
      hd.lastActionDate,
      hd.callsign && LEASE_CALLSIGN.test(hd.callsign) ? 1 : 0,
    ],
    db.prepare(
      `INSERT OR IGNORE INTO temp.stage_hd (usi, callsign, license_status, radio_service_code,
         grant_date, expired_date, cancellation_date, effective_date, last_action_date, is_lease)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'EN',
    decodeEn,
    (en) =>
      en.entityType === 'L'
        ? [en.usi, en.entityName, en.city, en.state, en.frn, en.applicantType]
        : null,
    db.prepare(
      `INSERT OR IGNORE INTO temp.stage_en (usi, licensee_name, licensee_city, licensee_state, frn, applicant_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'AM',
    decodeAm,
    (am) => [am.usi, am.operatorClass, am.trusteeCallsign, am.previousCallsign, am.trusteeName],
    db.prepare(
      `INSERT OR IGNORE INTO temp.stage_am (usi, operator_class, trustee_callsign, previous_callsign, trustee_name)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'MK',
    decodeMk,
    (mk) => [mk.usi, mk.marketCode, mk.channelBlock, mk.marketName, marketStates(mk.marketName)],
    db.prepare(
      `INSERT OR IGNORE INTO temp.stage_mk (usi, market_code, channel_block, market_name, market_states)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'LL',
    decodeLl,
    (ll) => [ll.leaseUsi, ll.parentUsi, ll.parentCallsign, ll.leaseId],
    db.prepare(
      'INSERT INTO temp.stage_ll (lease_usi, parent_usi, parent_callsign, lease_id) VALUES (?, ?, ?, ?)',
    ),
    signal,
    stats,
  );
  return stats;
}

/**
 * Stage LO (with decimal coordinates and derived site state), AN, FR, EM (with each
 * designator's bandwidth), and MF, keeping only rows whose USI is in `live`.
 */
async function stageTechnical(
  db: SqliteHandle,
  archive: ZipArchive,
  live: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<RecordStats> {
  db.exec(TECHNICAL_STAGING_DDL);
  const stats: RecordStats = {};
  await stageType(
    db,
    archive,
    'LO',
    decodeLo,
    (lo) => {
      if (!live.has(lo.usi)) return null;
      const filed = lo.state?.toUpperCase() ?? null;
      const derived =
        filed === null && lo.latitude !== null && lo.longitude !== null
          ? stateAt(lo.latitude, lo.longitude)
          : null;
      return [
        lo.usi,
        lo.locationNumber,
        lo.locationTypeCode,
        lo.locationClassCode,
        lo.address,
        lo.city,
        lo.county,
        lo.state,
        lo.radiusOfOperationKm,
        lo.groundElevationM,
        lo.latitude,
        lo.longitude,
        lo.coordinatesDms,
        lo.asrNumber,
        lo.supportHeightM,
        lo.overallHeightM,
        lo.structureType,
        lo.locationName,
        filed ?? derived,
        derived === null ? 0 : 1,
      ];
    },
    db.prepare(
      `INSERT INTO temp.stage_lo (usi, location_number, location_type, location_class, address,
         city, county, state, radius_km, ground_elevation_m, lat, lon, coord_dms, asr_number,
         support_height_m, overall_height_m, structure_type, location_name, site_state, state_derived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'AN',
    decodeAn,
    (an) =>
      live.has(an.usi)
        ? [
            an.usi,
            an.locationNumber,
            an.antennaNumber,
            an.antennaTypeCode,
            an.heightToTipM,
            an.heightToCenterM,
            an.make,
            an.model,
            an.polarization,
            an.beamwidthDeg,
            an.gainDbi,
            an.azimuthDeg,
            an.haatM,
          ]
        : null,
    db.prepare(
      `INSERT INTO temp.stage_an (usi, location_number, antenna_number, antenna_type, height_to_tip_m,
         height_to_center_m, make, model, polarization, beamwidth_deg, gain_dbi, azimuth_deg, haat_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'FR',
    decodeFr,
    (fr) =>
      live.has(fr.usi)
        ? [
            fr.usi,
            fr.locationNumber,
            fr.antennaNumber,
            fr.freqSeqId,
            fr.classStationCode,
            fr.frequencyMhz,
            fr.upperMhz,
            fr.powerOutputW,
            fr.erpW,
            fr.eirpDbm,
            fr.transmitterMake,
            fr.transmitterModel,
          ]
        : null,
    db.prepare(
      `INSERT INTO temp.stage_fr (usi, location_number, antenna_number, freq_seq_id, class_station,
         frequency_mhz, upper_mhz, power_output_w, erp_w, eirp_dbm, transmitter_make, transmitter_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'EM',
    decodeEm,
    (em) =>
      live.has(em.usi)
        ? [
            em.usi,
            em.locationNumber,
            em.antennaNumber,
            em.freqSeqId,
            em.emissionCode,
            emissionBandwidthMhz(em.emissionCode),
          ]
        : null,
    db.prepare(
      `INSERT INTO temp.stage_em (usi, location_number, antenna_number, freq_seq_id, emission_code, bandwidth_mhz)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    signal,
    stats,
  );
  await stageType(
    db,
    archive,
    'MF',
    decodeMf,
    (mf) => (live.has(mf.usi) ? [mf.usi, mf.partitionAreaId ?? 0, mf.lowerMhz, mf.upperMhz] : null),
    db.prepare(
      'INSERT INTO temp.stage_mf (usi, partition_area_id, lower, upper) VALUES (?, ?, ?, ?)',
    ),
    signal,
    stats,
  );
  return stats;
}

/**
 * Insert the staged HD/EN/AM/MK rows of every USI in `temp.apply` into `licenses`, and
 * their LL rows into `lease_links`; register their service codes. Returns licenses inserted.
 */
function insertRecords(db: SqliteHandle): number {
  db.prepare(
    `INSERT OR IGNORE INTO licenses (usi, callsign, license_status, radio_service_code, grant_date,
         expired_date, cancellation_date, effective_date, last_action_date, licensee_name,
         licensee_city, licensee_state, frn, applicant_type, operator_class, trustee_callsign,
         previous_callsign, trustee_name, market_code, channel_block, market_name, market_states,
         service_group, is_individual, is_lease)
       SELECT h.usi, h.callsign, h.license_status, h.radio_service_code, h.grant_date,
         h.expired_date, h.cancellation_date, h.effective_date, h.last_action_date,
         e.licensee_name, e.licensee_city, e.licensee_state, e.frn, e.applicant_type,
         am.operator_class, am.trustee_callsign, am.previous_callsign, am.trustee_name,
         mk.market_code, mk.channel_block, mk.market_name, mk.market_states, a.service_group,
         CASE WHEN e.applicant_type = 'I'
                OR (e.applicant_type IS NULL AND h.radio_service_code IN (${INDIVIDUAL_SQL}))
              THEN 1 ELSE 0 END,
         h.is_lease
       FROM temp.stage_hd h
       JOIN temp.apply a ON a.usi = h.usi
       LEFT JOIN temp.stage_en e ON e.usi = h.usi
       LEFT JOIN temp.stage_am am ON am.usi = h.usi
       LEFT JOIN temp.stage_mk mk ON mk.usi = h.usi`,
  ).run();
  db.exec(
    `INSERT INTO lease_links (lease_usi, parent_usi, parent_callsign, lease_id)
       SELECT ll.lease_usi, ll.parent_usi, ll.parent_callsign, ll.lease_id
       FROM temp.stage_ll ll JOIN temp.apply a ON a.usi = ll.lease_usi;
     INSERT OR IGNORE INTO service_codes (code, service_group)
       SELECT DISTINCT h.radio_service_code, a.service_group
       FROM temp.stage_hd h JOIN temp.apply a ON a.usi = h.usi
       WHERE h.radio_service_code IS NOT NULL;`,
  );
  // Counted rather than read from `changes`, which some drivers inflate with FTS trigger writes.
  return (
    db
      .prepare<{ n: number }>(
        'SELECT count(*) AS n FROM licenses WHERE usi IN (SELECT usi FROM temp.apply)',
      )
      .get()?.n ?? 0
  );
}

/**
 * Insert staged technical rows. Frequencies take their emissions (distinct, comma-joined)
 * and widest necessary bandwidth from EM rows joined on `(usi, location, antenna,
 * freq_seq_id)`, and the occupied band `[f − bw/2, (upper ?? f) + bw/2]`. A bandwidth of
 * {@link MAX_FRACTIONAL_BANDWIDTH} × f or more is a filing error and counts as none. EM
 * rows with no FR partner are dropped and counted in `stats.EM.orphaned`. Sites a license
 * files under one location number take `site_seq` 1, 2, … in filing order.
 */
function insertTechnical(db: SqliteHandle, stats: RecordStats): void {
  const bandwidth = `max(CASE WHEN e.bandwidth_mhz < ${MAX_FRACTIONAL_BANDWIDTH} * f.frequency_mhz
    THEN e.bandwidth_mhz END)`;
  const locationColumns = `location_type, location_class, address, city, county, state, radius_km,
    ground_elevation_m, lat, lon, coord_dms, asr_number, support_height_m, overall_height_m,
    structure_type, location_name, site_state, state_derived`;
  db.exec(
    `CREATE INDEX temp.stage_em_key ON stage_em (usi, location_number, antenna_number, freq_seq_id);
     CREATE INDEX temp.stage_fr_key ON stage_fr (usi, location_number, antenna_number, freq_seq_id);
     INSERT INTO locations (usi, location_number, site_seq, ${locationColumns})
       SELECT usi, location_number,
         row_number() OVER (PARTITION BY usi, location_number ORDER BY rowid), ${locationColumns}
       FROM temp.stage_lo;
     INSERT INTO antennas SELECT * FROM temp.stage_an;
     INSERT INTO frequencies (usi, location_number, antenna_number, freq_seq_id, class_station,
       frequency_mhz, upper_mhz, power_output_w, erp_w, eirp_dbm, transmitter_make,
       transmitter_model, emissions, bandwidth_mhz, occ_low, occ_high)
       SELECT f.usi, f.location_number, f.antenna_number, f.freq_seq_id, f.class_station,
         f.frequency_mhz, f.upper_mhz, f.power_output_w, f.erp_w, f.eirp_dbm, f.transmitter_make,
         f.transmitter_model, group_concat(DISTINCT e.emission_code), ${bandwidth},
         f.frequency_mhz - COALESCE(${bandwidth}, 0) / 2.0,
         COALESCE(f.upper_mhz, f.frequency_mhz) + COALESCE(${bandwidth}, 0) / 2.0
       FROM temp.stage_fr f
       LEFT JOIN temp.stage_em e ON e.usi = f.usi AND e.location_number = f.location_number
         AND e.antenna_number = f.antenna_number AND e.freq_seq_id = f.freq_seq_id
       GROUP BY f.rowid;
     INSERT INTO market_blocks SELECT * FROM temp.stage_mf;`,
  );
  const em = stats.EM;
  if (em) {
    em.orphaned =
      db
        .prepare<{ orphaned: number }>(
          `SELECT count(*) AS orphaned FROM temp.stage_em e
           WHERE NOT EXISTS (SELECT 1 FROM temp.stage_fr f WHERE f.usi = e.usi
             AND f.location_number = e.location_number AND f.antenna_number = e.antenna_number
             AND f.freq_seq_id = e.freq_seq_id)`,
        )
        .get()?.orphaned ?? 0;
  }
}

/**
 * Widen the stored widest-band bounds to cover the rows of every USI in `temp.apply`, in the
 * daily file's transaction. The overlap range scans trust these bounds, so a committed row
 * wider than them must never be visible without them — not to a reader mid-run, and not
 * after a refresh that stops partway, before {@link recomputeSummaries} runs.
 */
function widenBandBounds(db: SqliteHandle): void {
  db.exec(
    `UPDATE meta SET value = max(CAST(value AS REAL), COALESCE((SELECT max(occ_high - occ_low)
       FROM frequencies WHERE usi IN (SELECT usi FROM temp.apply)), 0))
     WHERE key = '${META_KEYS.maxSiteBand}';
     UPDATE meta SET value = max(CAST(value AS REAL), COALESCE((SELECT max(COALESCE(upper, lower) - lower)
       FROM market_blocks WHERE lower > 0 AND usi IN (SELECT usi FROM temp.apply)), 0))
     WHERE key = '${META_KEYS.maxMarketBand}';`,
  );
}

/**
 * Refresh derived bookkeeping after a run: per-code record counts, the widest site and
 * market bands (which bound the overlap range scans; a daily file only widens them, see
 * {@link widenBandBounds}), and per-group coverage counts. A market block with a 0 lower
 * edge records a channel width, not a frequency, so it never bounds a scan.
 */
function recomputeSummaries(db: SqliteHandle): void {
  const count = (sql: string) => db.prepare<{ group: string | null; n: number }>(sql).all();
  const stats: GroupStats = {};
  const entry = (group: string | null) => {
    const key = group ?? 'unknown';
    stats[key] ??= { records: 0, sites: 0, frequencies: 0 };
    return stats[key];
  };
  for (const row of count(
    'SELECT service_group AS "group", count(*) AS n FROM licenses GROUP BY service_group',
  )) {
    entry(row.group).records = row.n;
  }
  for (const row of count(
    'SELECT l.service_group AS "group", count(*) AS n FROM locations lo JOIN licenses l ON l.usi = lo.usi GROUP BY l.service_group',
  )) {
    entry(row.group).sites = row.n;
  }
  for (const row of count(
    'SELECT l.service_group AS "group", count(*) AS n FROM frequencies f JOIN licenses l ON l.usi = f.usi GROUP BY l.service_group',
  )) {
    entry(row.group).frequencies = row.n;
  }
  db.transaction(() => {
    db.exec(
      `UPDATE service_codes SET record_count =
         (SELECT count(*) FROM licenses WHERE radio_service_code = service_codes.code);
       INSERT OR REPLACE INTO meta (key, value) VALUES ('${META_KEYS.maxSiteBand}',
         (SELECT COALESCE(max(occ_high - occ_low), 0) FROM frequencies));
       INSERT OR REPLACE INTO meta (key, value) VALUES ('${META_KEYS.maxMarketBand}',
         (SELECT COALESCE(max(COALESCE(upper, lower) - lower), 0) FROM market_blocks
          WHERE lower > 0));`,
    );
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      META_KEYS.groupStats,
      JSON.stringify(stats),
    );
  });
}
