/**
 * @fileoverview Server-specific configuration: mirror location, indexed service
 * groups, individual-licensee redaction, and the ULS bulk host.
 * @module config/server-config
 */

import { resolve } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { DEFAULT_SERVICE_GROUPS, SERVICE_GROUPS, type ServiceGroup } from '@/services/uls/codes.js';

const GROUP_BY_LOWER = new Map(SERVICE_GROUPS.map((group) => [group.toLowerCase(), group]));

/** Only an explicit off-word disables redaction; anything else — typos included — keeps it on. */
const REDACTION_OFF = new Set(['false', '0', 'no', 'off']);

const ServerConfigSchema = z.object({
  mirrorDir: z
    .string()
    .default('.mirror/fcc-uls')
    .transform((dir) => resolve(dir))
    .describe('Directory for index generations, current.json, the ingest lock, and temp zips'),
  services: z
    .string()
    .default(DEFAULT_SERVICE_GROUPS.join(','))
    .transform((list, ctx) => {
      const groups = new Set<ServiceGroup>();
      for (const raw of list.split(',')) {
        const name = raw.trim();
        if (!name) continue;
        const group = GROUP_BY_LOWER.get(name.toLowerCase());
        if (!group) {
          ctx.addIssue({
            code: 'custom',
            message: `Unknown service group "${name}". Valid groups: ${SERVICE_GROUPS.join(', ')} (frc is never indexed).`,
          });
          return z.NEVER;
        }
        groups.add(group);
      }
      if (groups.size === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `No service group selected. Valid groups: ${SERVICE_GROUPS.join(', ')}.`,
        });
        return z.NEVER;
      }
      return SERVICE_GROUPS.filter((group) => groups.has(group));
    })
    .describe('Weekly service groups to index'),
  redactIndividuals: z
    .string()
    .optional()
    .transform((value) => !REDACTION_OFF.has(value?.trim().toLowerCase() ?? ''))
    .describe('Redact individual licensees; fail-safe (only false/0/no/off disables)'),
  baseUrl: z
    .url()
    .default('https://data.fcc.gov/download/pub/uls')
    .transform((url) => url.replace(/\/+$/, ''))
    .describe('ULS bulk host root'),
});

/** Parsed server configuration. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parse and cache the server configuration from the environment. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mirrorDir: 'FCC_SPECTRUM_MIRROR_DIR',
    services: 'FCC_SPECTRUM_SERVICES',
    redactIndividuals: 'FCC_SPECTRUM_REDACT_INDIVIDUALS',
    baseUrl: 'FCC_SPECTRUM_BASE_URL',
  });
  return _config;
}
