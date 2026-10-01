/**
 * @fileoverview `bun run mirror:verify` — check the published ULS index. Runs SQLite's
 * integrity check, then compares, per weekly snapshot, the line counts in its `counts`
 * file with the lines the ingester read (a mismatch means a zip entry was not streamed in
 * full) and the licenses indexed with those loaded at build time. Exits non-zero on any
 * failure. Before daily files are applied, the license counts must match exactly.
 * @module scripts/fcc-mirror-verify
 */

import { join } from 'node:path';
import { createUlsStore, type RecordStats, readPointer } from '@/services/uls/schema.js';
import { runScript } from './_mirror-context.js';

interface IngestFile {
  counts_created: string;
  counts_json: string;
  kind: string;
  path: string;
  service_group: string | null;
  stage: string;
  stats_json: string;
}

await runScript(async ({ config, logger }) => {
  const pointer = await readPointer(config.mirrorDir);
  if (!pointer) throw new Error(`No published index in ${config.mirrorDir}; run mirror:init.`);
  const store = createUlsStore(join(config.mirrorDir, pointer.file));
  const failures: string[] = [];
  try {
    const integrity = await store.integrityCheck();
    if (!integrity.ok) failures.push(`integrity check: ${integrity.results.join('; ')}`);
    const state = await store.readState();
    const db = await store.raw();
    const files = db.prepare<IngestFile>('SELECT * FROM ingest_files ORDER BY path').all();
    const dailyApplied = files.filter((file) => file.kind === 'daily').length;

    const report: Record<string, unknown>[] = [];
    for (const file of files.filter((row) => row.kind === 'weekly')) {
      const upstream = JSON.parse(file.counts_json) as Record<string, number>;
      const stats = JSON.parse(file.stats_json) as RecordStats;
      if (file.stage !== 'complete') failures.push(`${file.path}: stage ${file.stage}`);
      for (const [type, lines] of Object.entries(stats)) {
        const expected = upstream[type];
        if (expected !== undefined && expected !== lines.read) {
          failures.push(`${file.path} ${type}: read ${lines.read} of ${expected} lines`);
        }
      }
      const indexed =
        db
          .prepare<{ n: number }>('SELECT count(*) AS n FROM licenses WHERE service_group = ?')
          .get(file.service_group)?.n ?? 0;
      const loaded = stats.HD?.kept ?? 0;
      if (dailyApplied === 0 && indexed !== loaded) {
        failures.push(`${file.path}: ${indexed} licenses indexed, ${loaded} loaded at build`);
      }
      report.push({
        group: file.service_group,
        snapshotCreated: file.counts_created,
        licensesIndexed: indexed,
        lines: Object.fromEntries(
          Object.entries(stats).map(([type, lines]) => [
            type,
            { upstream: upstream[type], ...lines },
          ]),
        ),
      });
    }

    const tables = Object.fromEntries(
      ['licenses', 'lease_links', 'locations', 'antennas', 'frequencies', 'market_blocks'].map(
        (table) => [
          table,
          db.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0,
        ],
      ),
    );
    console.log(
      JSON.stringify(
        {
          generation: pointer.file,
          publishedAt: pointer.publishedAt,
          syncState: state,
          integrity: integrity.ok ? 'ok' : integrity.results,
          dailyFilesApplied: dailyApplied,
          tables,
          groups: report,
          failures,
        },
        null,
        2,
      ),
    );
  } finally {
    await store.close();
  }
  if (failures.length) throw new Error(`Verification failed: ${failures.length} problem(s).`);
  logger.info?.('Verification passed', { generation: pointer.file });
});
