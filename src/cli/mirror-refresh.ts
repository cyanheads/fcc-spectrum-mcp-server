/**
 * @fileoverview `bun run mirror:refresh` — daily refresh of the published ULS index.
 * Applies every `daily/l_*.zip` newer than the index checkpoint, oldest first, replacing
 * each license's record set by USI; files of weekly groups the index does not hold are
 * skipped without a request. Fails with a pointer to `mirror:init` when daily publication
 * dates show a gap after the checkpoint or a possibly overwritten file.
 * @module cli/mirror-refresh
 */

import { runScript } from './mirror-context.js';

await runScript(async ({ config, ingester, logger, signal }) => {
  logger.info?.('Starting daily refresh', { mirrorDir: config.mirrorDir });
  const outcome = await ingester.refresh(signal);
  console.log(JSON.stringify(outcome, null, 2));
});
