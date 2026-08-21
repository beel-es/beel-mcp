import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { API_KEY_PREFIX, BEEL_DEFAULTS, ENV_VAR } from './shared/defaults.js';
import { ambientEnv, readEnv, readEnvUrl, type EnvRecord } from './shared/env.js';

/**
 * Resolves the API key, environment and base URL for the BeeL API.
 *
 * MCP servers are configured through environment variables in the client's
 * config, so `BEEL_API_KEY` is the primary source. As a convenience we also fall
 * back to the CLI's config file (~/.config/beel/config.json), so a user who ran
 * `beel login` can reuse those credentials with the MCP server.
 *
 * Only the stdio transport uses this. The remote server derives an equivalent
 * config per request from the caller's OAuth token.
 */

export type KeyEnv = 'test' | 'live';

export class ConfigError extends Error {}

interface ConfigFile {
  testKey?: string;
  liveKey?: string;
}

/** Classify a key by its prefix; null if it isn't a recognisable BeeL key. */
export function classifyKey(key: string): KeyEnv | null {
  for (const [env, prefix] of Object.entries(API_KEY_PREFIX) as [KeyEnv, string][]) {
    if (key.startsWith(prefix) && key.length > prefix.length) return env;
  }
  return null;
}

function configPath(env: EnvRecord): string {
  const dir = readEnv(env, ENV_VAR.configDir) ?? join(homedir(), '.config', 'beel');
  return join(dir, 'config.json');
}

function loadConfigFile(env: EnvRecord): ConfigFile {
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
}

/**
 * Resolve credentials. Precedence: `BEEL_API_KEY` (env) → config file (selected by
 * `BEEL_ENV`, default `test`). Throws a ConfigError with actionable guidance if no
 * usable key is found.
 */
export function resolveConfig(env: EnvRecord = ambientEnv()): ResolvedConfig {
  const baseUrl = readEnvUrl(env, ENV_VAR.apiBaseUrl, BEEL_DEFAULTS.apiBaseUrl);

  const fromEnv = readEnv(env, ENV_VAR.apiKey);
  if (fromEnv) {
    const keyEnv = classifyKey(fromEnv);
    if (!keyEnv) {
      throw new ConfigError(
        `${ENV_VAR.apiKey} does not look like a BeeL key ` +
          `(expected prefix ${API_KEY_PREFIX.test} or ${API_KEY_PREFIX.live}).`,
      );
    }
    return { apiKey: fromEnv, env: keyEnv, baseUrl };
  }

  const target: KeyEnv = readEnv(env, ENV_VAR.keyEnvironment) === 'live' ? 'live' : 'test';
  const file = loadConfigFile(env);
  const key = target === 'live' ? file.liveKey : file.testKey;
  if (!key) {
    throw new ConfigError(
      `No BeeL API key found. Set ${ENV_VAR.apiKey} in the MCP server environment ` +
        `(a ${target} key, prefix ${API_KEY_PREFIX[target]}), or run \`beel login\` with the CLI.`,
    );
  }
  return { apiKey: key, env: target, baseUrl };
}
