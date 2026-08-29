import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { API_KEY_PREFIX, BEEL_DEFAULTS, ENV_VAR } from './shared/defaults.js';
import { ambientEnv, readEnv, stripTrailingSlash, type EnvRecord } from './shared/env.js';
import { isRecord } from './shared/guards.js';

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

/**
 * Name of the variable that permits a plaintext base URL. Not in `ENV_VAR` yet;
 * see HANDOFF.md.
 */

/** Hosts for which plaintext HTTP may be permitted: a developer's own machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

/**
 * Read the CLI's config file.
 *
 * The shape is validated rather than asserted: the file is written by another
 * program and edited by hand, so `{ testKey: 42 }` is a real possibility. Cast
 * blindly, a number reaches the Authorization header as "42". A malformed file
 * is a ConfigError naming the file, never a silent fallback to "no key found",
 * which sends the user hunting for a key they already configured.
 */
function loadConfigFile(env: EnvRecord): ConfigFile {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `${path} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) throw new ConfigError(`${path} must contain a JSON object.`);
  const file: ConfigFile = {};
  for (const key of ['testKey', 'liveKey'] as const) {
    const value = parsed[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new ConfigError(`${path}: "${key}" must be a string.`);
    }
    if (value.trim().length > 0) file[key] = value.trim();
  }
  return file;
}

/**
 * The API base URL, which must be reachable over TLS.
 *
 * The API key travels on every request in an Authorization header, so a
 * plaintext base URL puts a live credential on the wire. Loopback is the one
 * exception, and only when explicitly asked for, so that pointing the server at
 * a local API stays possible without making the mistake easy.
 */
export function readBaseUrl(env: EnvRecord, name: string, fallback: string): string {
  const raw = readEnv(env, name);
  if (!raw) return stripTrailingSlash(fallback);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid absolute URL: ${raw}`);
  }
  if (url.protocol === 'https:') return stripTrailingSlash(raw);
  if (url.protocol !== 'http:') {
    throw new ConfigError(`${name} must use https (got ${url.protocol.replace(':', '')}).`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  const permitted = readEnv(env, ENV_VAR.allowInsecureBaseUrl) === 'true';
  if (loopback && permitted) return stripTrailingSlash(raw);
  throw new ConfigError(
    loopback
      ? `${name} uses plaintext http. Set ${ENV_VAR.allowInsecureBaseUrl}=true to allow it for local development.`
      : `${name} must use https: the API key travels in a header on every request (got ${raw}).`,
  );
}

export interface ResolvedConfig {
  apiKey: string;
  env: KeyEnv;
  baseUrl: string;
  /**
   * How the caller reached this server. It decides how a credential problem is
   * phrased: a stdio user edits an environment variable in their MCP client
   * config, a remote user re-runs an OAuth authorization. Defaults to `stdio`
   * when a config provider omits it.
   */
  transport?: Transport;
}

/** The transports this server is reachable over. */
export type Transport = 'stdio' | 'remote';

/**
 * Resolve credentials. Precedence: `BEEL_API_KEY` (env) → config file (selected by
 * `BEEL_ENV`, default `test`). Throws a ConfigError with actionable guidance if no
 * usable key is found.
 */
export function resolveConfig(env: EnvRecord = ambientEnv()): ResolvedConfig {
  const baseUrl = readBaseUrl(env, ENV_VAR.apiBaseUrl, BEEL_DEFAULTS.apiBaseUrl);

  const fromEnv = readEnv(env, ENV_VAR.apiKey);
  if (fromEnv) {
    const keyEnv = classifyKey(fromEnv);
    if (!keyEnv) {
      throw new ConfigError(
        `${ENV_VAR.apiKey} does not look like a BeeL key ` +
          `(expected prefix ${API_KEY_PREFIX.test} or ${API_KEY_PREFIX.live}).`,
      );
    }
    return { apiKey: fromEnv, env: keyEnv, baseUrl, transport: 'stdio' };
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
  return { apiKey: key, env: target, baseUrl, transport: 'stdio' };
}
