import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves the API key, environment and base URL for the BeeL API.
 *
 * MCP servers are configured through environment variables in the client's
 * config, so `BEEL_API_KEY` is the primary source. As a convenience we also fall
 * back to the CLI's config file (~/.config/beel/config.json), so a user who ran
 * `beel login` can reuse those credentials with the MCP server.
 */

export type KeyEnv = 'test' | 'live';

const KEY_PREFIXES: Record<KeyEnv, string> = {
  test: 'beel_sk_test_',
  live: 'beel_sk_live_',
};

const DEFAULT_BASE_URL = 'https://app.beel.es/api';

export class ConfigError extends Error {}

interface ConfigFile {
  testKey?: string;
  liveKey?: string;
}

/** Classify a key by its prefix; null if it isn't a recognisable BeeL key. */
export function classifyKey(key: string): KeyEnv | null {
  for (const [env, prefix] of Object.entries(KEY_PREFIXES) as [KeyEnv, string][]) {
    if (key.startsWith(prefix) && key.length > prefix.length) return env;
  }
  return null;
}

function configPath(env: NodeJS.ProcessEnv): string {
  const dir = env.BEEL_CONFIG_DIR ?? join(homedir(), '.config', 'beel');
  return join(dir, 'config.json');
}

function loadConfigFile(env: NodeJS.ProcessEnv): ConfigFile {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
  } catch {
    return {};
  }
}

export interface ResolvedConfig {
  apiKey: string;
  env: KeyEnv;
  baseUrl: string;
  activeCompany?: string;
}

/**
 * Resolve credentials. Precedence: `BEEL_API_KEY` (env) → config file (selected by
 * `BEEL_ENV`, default `test`). Throws a ConfigError with actionable guidance if no
 * usable key is found.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const baseUrl = env.BEEL_BASE_URL ?? DEFAULT_BASE_URL;
  const activeCompany = env.BEEL_ACTIVE_COMPANY?.trim() || undefined;

  const fromEnv = env.BEEL_API_KEY?.trim();
  if (fromEnv) {
    const keyEnv = classifyKey(fromEnv);
    if (!keyEnv) {
      throw new ConfigError(
        'BEEL_API_KEY does not look like a BeeL key (expected prefix beel_sk_test_ or beel_sk_live_).',
      );
    }
    return { apiKey: fromEnv, env: keyEnv, baseUrl, activeCompany };
  }

  const target: KeyEnv = env.BEEL_ENV === 'live' ? 'live' : 'test';
  const file = loadConfigFile(env);
  const key = target === 'live' ? file.liveKey : file.testKey;
  if (!key) {
    throw new ConfigError(
      `No BeeL API key found. Set BEEL_API_KEY in the MCP server environment ` +
        `(a ${target} key, prefix beel_sk_${target}_), or run \`beel login\` with the CLI.`,
    );
  }
  return { apiKey: key, env: target, baseUrl, activeCompany };
}
