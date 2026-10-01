/**
 * @fileoverview Fixture-backed ULS index for DB-backed tests. `buildFixtureIndex` runs the
 * real `UlsIngester` over the weekly fixture zips (and, optionally, daily fixtures) into a
 * temp mirror directory, then hands out `UlsIndexService` instances over that generation
 * with redaction on or off. `dispose()` closes every service it handed out and removes the
 * directory.
 * @module tests/fixtures/uls-index
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { type IngestClient, UlsIngester } from '@/services/uls/ingest.js';
import { type FrequencySearchLimits, UlsIndexService } from '@/services/uls/uls-index-service.js';
import type { ZipArchive } from '@/services/uls/zip-reader.js';
import { at, FakeIngestClient, type FixtureFile, type WEEKLY_FIXTURES } from './uls-fixtures.js';

/** The clock every fixture ingest runs on. */
export const FIXTURE_NOW = at('2026-09-29T20:00:00Z');

/** A weekly group the fixture kit has a snapshot for. */
export type FixtureGroup = keyof typeof WEEKLY_FIXTURES;

/** All three fixture groups, in build order. */
export const FIXTURE_GROUPS: readonly FixtureGroup[] = ['paging', 'mdsitfs', 'amat'];

/** Generation the three fixture groups build into (named from paging's `Last-Modified`). */
export const FIXTURE_GENERATION = 'fcc-uls-20260927T133855Z.db';

/** A fresh directory under `os.tmpdir()`. */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `fcc-spectrum-${prefix}-`));
}

/** A temp root holding an empty mirror directory and a separate zip temp directory. */
export interface TempMirror {
  mirrorDir: string;
  /** Remove the whole root. */
  remove(): Promise<void>;
  root: string;
  tempDir: string;
}

/** Create a temp root with `mirror/` (created) and `tmp/` (left for the ingester to create). */
export async function makeTempMirror(prefix: string): Promise<TempMirror> {
  const root = await makeTempDir(prefix);
  const mirrorDir = join(root, 'mirror');
  await mkdir(mirrorDir);
  return {
    root,
    mirrorDir,
    tempDir: join(root, 'tmp'),
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

/** Options for {@link fixtureIngester}. */
export interface FixtureIngesterOptions {
  client: IngestClient;
  groups?: readonly FixtureGroup[];
  logger?: MirrorLogger;
  now?: number;
  openArchive?: (path: string) => Promise<ZipArchive>;
}

/** A `UlsIngester` over a temp mirror, on the fixture clock unless `now` says otherwise. */
export function fixtureIngester(mirror: TempMirror, options: FixtureIngesterOptions): UlsIngester {
  const now = options.now ?? FIXTURE_NOW;
  return new UlsIngester({
    client: options.client,
    mirrorDir: mirror.mirrorDir,
    tempDir: mirror.tempDir,
    services: options.groups ?? FIXTURE_GROUPS,
    now: () => now,
    ...(options.logger && { logger: options.logger }),
    ...(options.openArchive && { openArchive: options.openArchive }),
  });
}

/** Options for {@link UlsIndexService} instances handed out by a fixture index. */
export interface FixtureServiceOptions {
  frequencySearch?: Partial<FrequencySearchLimits>;
  pointerCheckMs?: number;
  redactIndividuals?: boolean;
}

/** A built fixture index. */
export interface FixtureIndex {
  client: FakeIngestClient;
  /** Close every service handed out and remove the temp root. */
  dispose(): Promise<void>;
  /** The published generation file name. */
  generation: string;
  groups: readonly FixtureGroup[];
  ingester: UlsIngester;
  mirror: TempMirror;
  mirrorDir: string;
  /** A new service over the index; redaction on and `pointerCheckMs: 0` by default. */
  service(options?: FixtureServiceOptions): UlsIndexService;
}

/** Options for {@link buildFixtureIndex}. */
export interface FixtureIndexOptions {
  /** Daily files to apply after the rebuild, by `daily/` file name. */
  daily?: Record<string, FixtureFile>;
  groups?: readonly FixtureGroup[];
  /** Snapshots served in place of a group's weekly fixture. */
  weekly?: Partial<Record<FixtureGroup, FixtureFile>>;
}

/** Build a generation from the weekly fixtures (all three groups by default) and publish it. */
export async function buildFixtureIndex(options: FixtureIndexOptions = {}): Promise<FixtureIndex> {
  const groups = options.groups ?? FIXTURE_GROUPS;
  const mirror = await makeTempMirror('index');
  const client = new FakeIngestClient().withWeekly(groups);
  for (const [group, file] of Object.entries(options.weekly ?? {})) {
    if (file) client.set(`complete/l_${group}.zip`, file);
  }
  const ingester = fixtureIngester(mirror, { client, groups });
  const { generation } = await ingester.rebuild();
  if (options.daily) {
    client.withDaily(options.daily);
    await ingester.refresh();
  }
  const services: UlsIndexService[] = [];
  return {
    client,
    generation,
    groups,
    ingester,
    mirror,
    mirrorDir: mirror.mirrorDir,
    service({ redactIndividuals = true, pointerCheckMs = 0, frequencySearch } = {}) {
      const service = new UlsIndexService({
        mirrorDir: mirror.mirrorDir,
        pointerCheckMs,
        redactIndividuals,
        services: groups,
        ...(frequencySearch && { frequencySearch }),
      });
      services.push(service);
      return service;
    },
    async dispose() {
      await Promise.all(services.map((service) => service.close()));
      await mirror.remove();
    },
  };
}
