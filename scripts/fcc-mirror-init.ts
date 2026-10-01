/**
 * @fileoverview `bun run mirror:init` — weekly rebuild of the ULS index. Downloads each
 * selected service group's weekly snapshot into a fresh index generation and publishes it
 * through `current.json`. Skips when the published generation already holds every
 * selected snapshot; resumes from the last completed step after an interruption.
 * @module scripts/fcc-mirror-init
 */

import { runScript } from './_mirror-context.js';

await runScript(async ({ config, ingester, logger, signal }) => {
  logger.info?.('Starting weekly rebuild', {
    mirrorDir: config.mirrorDir,
    services: config.services.join(','),
  });
  const outcome = await ingester.rebuild(signal);
  console.log(JSON.stringify(outcome, null, 2));
});
