/**
 * @fileoverview Tests for the server configuration: defaults, service-group parsing,
 * fail-safe redaction, base URL cleanup, and caching. Each case re-imports the module
 * so the lazily cached config starts empty.
 * @module tests/config/server-config.test
 */

import { resolve } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVICE_GROUPS, SERVICE_GROUPS } from '@/services/uls/codes.js';

const ENV_KEYS = [
  'FCC_SPECTRUM_MIRROR_DIR',
  'FCC_SPECTRUM_SERVICES',
  'FCC_SPECTRUM_REDACT_INDIVIDUALS',
  'FCC_SPECTRUM_BASE_URL',
] as const;

/** Load a fresh `getServerConfig` with the given environment ('' reads as unset). */
async function loadConfig(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  for (const key of ENV_KEYS) vi.stubEnv(key, env[key] ?? '');
  vi.resetModules();
  const mod = await import('@/config/server-config.js');
  return mod.getServerConfig;
}

/** The error thrown by `getServerConfig()`. */
async function configError(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const getServerConfig = await loadConfig(env);
  try {
    getServerConfig();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected getServerConfig() to throw');
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getServerConfig defaults', () => {
  it('uses the documented defaults when nothing is set', async () => {
    const config = (await loadConfig())();
    expect(config.services).toEqual([...DEFAULT_SERVICE_GROUPS]);
    expect(config.redactIndividuals).toBe(true);
    expect(config.baseUrl).toBe('https://data.fcc.gov/download/pub/uls');
    expect(config.mirrorDir).toBe(resolve('.mirror/fcc-uls'));
  });

  it('resolves a relative mirror directory to an absolute path', async () => {
    const config = (await loadConfig({ FCC_SPECTRUM_MIRROR_DIR: 'data/mirror' }))();
    expect(config.mirrorDir).toBe(resolve('data/mirror'));
    expect(config.mirrorDir.startsWith('/')).toBe(true);
  });

  it('keeps an absolute mirror directory as given', async () => {
    const config = (await loadConfig({ FCC_SPECTRUM_MIRROR_DIR: '/var/lib/fcc-uls' }))();
    expect(config.mirrorDir).toBe('/var/lib/fcc-uls');
  });
});

describe('FCC_SPECTRUM_SERVICES', () => {
  it('matches names case-insensitively, restoring the FCC spelling', async () => {
    const config = (await loadConfig({ FCC_SPECTRUM_SERVICES: 'lmpriv,PAGING, Amat' }))();
    expect(config.services).toEqual(['LMpriv', 'paging', 'amat']);
  });

  it('dedupes and returns groups in canonical order', async () => {
    const config = (await loadConfig({ FCC_SPECTRUM_SERVICES: 'amat,paging,AMAT,micro,paging' }))();
    expect(config.services).toEqual(['micro', 'paging', 'amat']);
  });

  it('accepts every valid group, including those outside the defaults', async () => {
    const config = (await loadConfig({ FCC_SPECTRUM_SERVICES: [...SERVICE_GROUPS].join(',') }))();
    expect(config.services).toEqual([...SERVICE_GROUPS]);
  });

  it('skips empty items between commas', async () => {
    const config = (await loadConfig({ FCC_SPECTRUM_SERVICES: ',paging,, ,amat,' }))();
    expect(config.services).toEqual(['paging', 'amat']);
  });

  it('rejects frc, naming the variable and the valid groups', async () => {
    const error = await configError({ FCC_SPECTRUM_SERVICES: 'paging,frc' });
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    expect(error.message).toContain('FCC_SPECTRUM_SERVICES');
    expect(error.message).toContain('frc');
    expect(error.message).toContain(SERVICE_GROUPS.join(', '));
  });

  it('rejects an unknown group', async () => {
    const error = await configError({ FCC_SPECTRUM_SERVICES: 'paging,ham' });
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    expect(error.message).toContain('FCC_SPECTRUM_SERVICES');
    expect(error.message).toContain('Unknown service group "ham"');
  });

  it('says no group is selected when the list holds only separators', async () => {
    const error = await configError({ FCC_SPECTRUM_SERVICES: ',,' });
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    expect(error.message).toContain('FCC_SPECTRUM_SERVICES');
    expect(error.message).toContain('No service group selected');
  });
});

describe('FCC_SPECTRUM_REDACT_INDIVIDUALS', () => {
  it.each(['false', '0', 'no', 'off', 'FALSE', 'Off', ' no ', '\toff\n'])(
    'turns redaction off for %j',
    async (value) => {
      const config = (await loadConfig({ FCC_SPECTRUM_REDACT_INDIVIDUALS: value }))();
      expect(config.redactIndividuals).toBe(false);
    },
  );

  it.each(['true', '1', 'yes', 'on', 'flase', 'disabled', 'nope'])(
    'keeps redaction on for %j',
    async (value) => {
      const config = (await loadConfig({ FCC_SPECTRUM_REDACT_INDIVIDUALS: value }))();
      expect(config.redactIndividuals).toBe(true);
    },
  );

  it('keeps redaction on when the variable is unset or blank', async () => {
    expect((await loadConfig({ FCC_SPECTRUM_REDACT_INDIVIDUALS: '   ' }))().redactIndividuals).toBe(
      true,
    );
  });
});

describe('FCC_SPECTRUM_BASE_URL', () => {
  it('strips trailing slashes', async () => {
    const config = (
      await loadConfig({ FCC_SPECTRUM_BASE_URL: 'https://mirror.example.test/uls///' })
    )();
    expect(config.baseUrl).toBe('https://mirror.example.test/uls');
  });

  it('rejects an invalid URL, naming the variable', async () => {
    const error = await configError({ FCC_SPECTRUM_BASE_URL: 'not a url' });
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    expect(error.message).toContain('FCC_SPECTRUM_BASE_URL');
  });
});

describe('caching', () => {
  it('parses once and returns the same object afterward', async () => {
    const getServerConfig = await loadConfig({ FCC_SPECTRUM_SERVICES: 'paging' });
    const first = getServerConfig();
    vi.stubEnv('FCC_SPECTRUM_SERVICES', 'amat');
    const second = getServerConfig();
    expect(second).toBe(first);
    expect(second.services).toEqual(['paging']);
  });

  it('does not cache a failed parse', async () => {
    const getServerConfig = await loadConfig({ FCC_SPECTRUM_SERVICES: 'bogus' });
    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.ConfigurationError }),
    );
    vi.stubEnv('FCC_SPECTRUM_SERVICES', 'amat');
    expect(getServerConfig().services).toEqual(['amat']);
  });
});
