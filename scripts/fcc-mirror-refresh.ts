/**
 * @fileoverview `bun run mirror:refresh` — daily refresh of the published ULS index.
 * Applies every `daily/l_*.zip` newer than the index checkpoint, oldest first, replacing
 * each license's record set by USI. Fails with a pointer to `mirror:init` when the
 * checkpoint is more than six days old.
 * @module scripts/fcc-mirror-refresh
 */

import { runScript } from './_mirror-context.js';

await runScript(async ({ config, ingester, logger, signal }) => {
  logger.info?.('Starting daily refresh', { mirrorDir: config.mirrorDir });
  const outcome = await ingester.refresh(signal);
  console.log(JSON.stringify(outcome, null, 2));
});
