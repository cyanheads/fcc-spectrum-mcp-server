/**
 * @fileoverview Loads `./.env` into `process.env` as a side effect of being imported.
 * `src/index.ts` imports it ahead of everything else: a definition reads server settings when
 * its module loads (the advertised `radius_km` ceiling), and `getServerConfig()` caches that
 * first parse, so `.env` must be in the environment before any definition evaluates. Node never
 * reads `.env` on its own; Bun does, and the repeat changes nothing, since
 * `process.loadEnvFile()` never overrides a variable already set. A missing file is fine.
 * @module config/load-env
 */

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
