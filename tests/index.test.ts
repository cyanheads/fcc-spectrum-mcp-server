/**
 * @fileoverview Tests for the server entry point's wiring: the `.env` preload, the options
 * passed to `createApp()` (definitions, session mode, the redaction sentence in the server
 * instructions), `setup()` initializing the index service from the server config and
 * starting the ingest schedule only under the HTTP transport, and `teardown()` stopping the
 * schedule before the index service closes. `createApp` and the schedule are mocked; each
 * case loads `src/index.ts` fresh under its own environment.
 * @module tests/index.test
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreServices, CreateAppOptions } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn(),
}));

vi.mock('@/services/uls/ingest-schedule.js', () => ({
  startIngestSchedule: vi.fn(async () => {}),
  stopIngestSchedule: vi.fn(),
}));

vi.mock('@/services/uls/uls-index-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/uls/uls-index-service.js')>();
  return { ...actual, initUlsIndexService: vi.fn(actual.initUlsIndexService) };
});

/** Never created: setup only constructs the index service, which opens nothing until queried. */
const MIRROR_DIR = join(tmpdir(), 'fcc-spectrum-index-test-unused');

const REDACTION_SENTENCE =
  "Individual licensees' names are redacted and excluded from name search.";

const DEFAULT_ENV = {
  FCC_SPECTRUM_MIRROR_DIR: MIRROR_DIR,
  FCC_SPECTRUM_SERVICES: 'amat, Paging',
  FCC_SPECTRUM_REDACT_INDIVIDUALS: '',
  FCC_SPECTRUM_BASE_URL: 'https://uls.invalid/download/pub/uls/',
};

const enoent = () =>
  Object.assign(new Error('ENOENT: no such file, open .env'), { code: 'ENOENT' });

const core = (mcpTransportType: 'http' | 'stdio') =>
  ({ config: { mcpTransportType } }) as unknown as CoreServices;

/**
 * Load `src/index.ts` fresh under `env`, with `process.loadEnvFile` replaced by `loadEnv`,
 * and return what it handed `createApp()` alongside the modules it wired.
 */
async function loadIndex(env: Record<string, string> = {}, loadEnv: () => void = () => {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...DEFAULT_ENV, ...env })) vi.stubEnv(name, value);
  const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(loadEnv);

  await import('@/index.js');

  const { createApp } = await import('@cyanheads/mcp-ts-core');
  const schedule = await import('@/services/uls/ingest-schedule.js');
  const indexService = await import('@/services/uls/uls-index-service.js');
  const tools = await import('@/mcp-server/tools/definitions/index.js');
  const resources = await import('@/mcp-server/resources/definitions/index.js');
  const calls = vi.mocked(createApp).mock.calls;
  expect(calls).toHaveLength(1);
  const options = calls[0]?.[0] as CreateAppOptions;
  return { options, loadEnvFile, schedule, indexService, tools, resources };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('.env preload', () => {
  it('loads ./.env before createApp() and tolerates its absence', async () => {
    const { loadEnvFile } = await loadIndex({}, () => {
      throw enoent();
    });
    const { createApp } = await import('@cyanheads/mcp-ts-core');
    expect(loadEnvFile).toHaveBeenCalled();
    for (const args of loadEnvFile.mock.calls) expect(args).toEqual([]);
    expect(loadEnvFile.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createApp).mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
  });

  it('fails startup when ./.env exists but cannot be read', async () => {
    vi.resetModules();
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied, open .env'), { code: 'EACCES' });
    });
    await expect(import('@/index.js')).rejects.toThrow('EACCES');
    const { createApp } = await import('@cyanheads/mcp-ts-core');
    expect(createApp).not.toHaveBeenCalled();
  });
});

describe('createApp() options', () => {
  it('registers every tool and resource definition, no prompts, and a stateless session', async () => {
    const { options, tools, resources } = await loadIndex();
    expect(options).toMatchObject({
      name: 'fcc-spectrum-mcp-server',
      title: 'fcc-spectrum-mcp-server',
      prompts: [],
      sessionMode: 'stateless',
    });
    expect(options.tools).toBe(tools.allToolDefinitions);
    expect(options.resources).toBe(resources.allResourceDefinitions);
  });

  it.each([
    ['unset (fail-safe on)', ''],
    ['an unrecognized value (fail-safe on)', 'maybe'],
    ['true', 'true'],
  ])('states the redaction policy in the instructions when redaction is %s', async (_l, value) => {
    const { options } = await loadIndex({ FCC_SPECTRUM_REDACT_INDIVIDUALS: value });
    expect(options.instructions).toContain(
      `every response carries dataAsOf. ${REDACTION_SENTENCE}`,
    );
    expect(options.instructions?.match(/redacted/g)).toHaveLength(1);
  });

  it.each(['false', 'OFF', ' 0 ', 'no'])(
    'leaves the redaction sentence out when FCC_SPECTRUM_REDACT_INDIVIDUALS is %j',
    async (value) => {
      const { options } = await loadIndex({ FCC_SPECTRUM_REDACT_INDIVIDUALS: value });
      expect(options.instructions).not.toContain('redacted');
      expect(options.instructions).toContain(
        'every response carries dataAsOf. Licensee names, addresses, site names, and market names are registry data',
      );
    },
  );
});

describe('setup()', () => {
  it('initializes the index service and starts the ingest schedule under HTTP', async () => {
    const { options, schedule, indexService } = await loadIndex();
    await options.setup?.(core('http'));

    expect(indexService.initUlsIndexService).toHaveBeenCalledWith({
      mirrorDir: MIRROR_DIR,
      redactIndividuals: true,
      services: ['paging', 'amat'],
    });
    expect(indexService.getUlsIndexService()).toBeInstanceOf(indexService.UlsIndexService);
    expect(schedule.startIngestSchedule).toHaveBeenCalledTimes(1);
    expect(schedule.startIngestSchedule).toHaveBeenCalledWith({
      baseUrl: 'https://uls.invalid/download/pub/uls',
      mirrorDir: MIRROR_DIR,
      services: ['paging', 'amat'],
    });
  });

  it('passes the redaction setting through to the index service', async () => {
    const { options, indexService } = await loadIndex({ FCC_SPECTRUM_REDACT_INDIVIDUALS: 'off' });
    await options.setup?.(core('http'));
    expect(indexService.initUlsIndexService).toHaveBeenCalledWith(
      expect.objectContaining({ redactIndividuals: false }),
    );
  });

  it('initializes the index service but starts no schedule under stdio', async () => {
    const { options, schedule, indexService } = await loadIndex();
    await options.setup?.(core('stdio'));
    expect(indexService.initUlsIndexService).toHaveBeenCalledTimes(1);
    expect(schedule.startIngestSchedule).not.toHaveBeenCalled();
  });

  it('fails setup when the schedule cannot start', async () => {
    const { options, schedule } = await loadIndex();
    vi.mocked(schedule.startIngestSchedule).mockRejectedValueOnce(new Error('cron unavailable'));
    await expect(options.setup?.(core('http'))).rejects.toThrow('cron unavailable');
  });
});

describe('teardown()', () => {
  it.each(['http', 'stdio'] as const)(
    'stops the schedule before the index service closes (%s)',
    async (transport) => {
      const { options, schedule, indexService } = await loadIndex();
      await options.setup?.(core(transport));
      const close = vi.spyOn(indexService.UlsIndexService.prototype, 'close');

      await options.teardown?.(core(transport));

      const stop = vi.mocked(schedule.stopIngestSchedule);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
        close.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
      );
      expect(close.mock.contexts[0]).toBe(indexService.getUlsIndexService());
    },
  );
});
