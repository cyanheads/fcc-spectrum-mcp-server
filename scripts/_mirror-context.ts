/**
 * @fileoverview Shared setup for the `mirror:*` lifecycle scripts: server config, a
 * console logger for the sync runner, the bulk client, the ingester, and an abort signal
 * wired to SIGINT/SIGTERM so an interrupted build persists its progress and resumes.
 * @module scripts/_mirror-context
 */

import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { UlsBulkClient } from '@/services/uls/bulk-client.js';
import { UlsIngester } from '@/services/uls/ingest.js';

/** Everything a lifecycle script needs. Call `dispose()` before exiting. */
export interface MirrorContext {
  client: UlsBulkClient;
  config: ServerConfig;
  dispose(): void;
  ingester: UlsIngester;
  logger: MirrorLogger;
  signal: AbortSignal;
}

function line(level: string, message: string, meta?: Readonly<Record<string, unknown>>): void {
  const detail = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console.error(`${new Date().toISOString()} ${level.padEnd(7)} ${message}${detail}`);
}

/** Console logger for the sync runner; everything goes to stderr, leaving stdout for results. */
export const consoleLogger: MirrorLogger = {
  debug: () => {},
  info: (message, meta) => line('info', message, meta),
  notice: (message, meta) => line('notice', message, meta),
  warning: (message, meta) => line('warning', message, meta),
  error: (message, meta) => line('error', message, meta),
};

/** Build the script context from `FCC_SPECTRUM_*` environment variables. */
export function createMirrorContext(): MirrorContext {
  const config = getServerConfig();
  const client = new UlsBulkClient({ baseUrl: config.baseUrl });
  const ingester = new UlsIngester({
    client,
    mirrorDir: config.mirrorDir,
    services: config.services,
    logger: consoleLogger,
  });
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) => {
    line('notice', `Received ${signal}; stopping after the current step is persisted.`);
    controller.abort(new Error(`Interrupted by ${signal}`));
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  return {
    config,
    client,
    ingester,
    logger: consoleLogger,
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
      client.dispose();
    },
  };
}

/** Run a script body, printing a failure and exiting non-zero on error. */
export async function runScript(body: (context: MirrorContext) => Promise<void>): Promise<void> {
  const context = createMirrorContext();
  try {
    await body(context);
  } catch (err) {
    line('error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    context.dispose();
  }
}
