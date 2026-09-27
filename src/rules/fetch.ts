/**
 * Load the fiscal rules catalogue from the docs site, with the same in-memory
 * cache as the other documentation files (works in Node and in a Worker
 * isolate alike).
 *
 * Order of preference: a fresh copy, then a stale copy from an earlier fetch,
 * then the snapshot bundled at build time. The snapshot exists so the rules
 * tools answer when the docs host is unreachable; it is written only by
 * `npm run sync:rules` and is never the primary source.
 */

import { BEEL_DEFAULTS, CACHE_TTL_MS, ENV_VAR, RULES_SOURCE } from '../shared/defaults.js';
import { ambientEnv, readEnvUrl, type EnvRecord } from '../shared/env.js';
import { fetchWithTimeout, readBoundedText } from '../shared/fetch.js';
import { parseRulesCatalog, type RulesCatalog } from './catalog.js';
import snapshot from './snapshot.json';

/** Where the catalogue in hand came from. */
export type RulesOrigin = 'live' | 'stale' | 'snapshot';

export interface LoadedRules {
  catalog: RulesCatalog;
  origin: RulesOrigin;
}

interface CacheEntry {
  catalog: RulesCatalog;
  origin: RulesOrigin;
  /** When this entry stops being served without trying the network again. */
  expiresAt: number;
}

let cache: CacheEntry | null = null;
/** The last copy that came from the network, kept to serve stale over the snapshot. */
let lastLive: RulesCatalog | null = null;
let bundled: RulesCatalog | null = null;

/** Drop the cache. Tests use it to observe fetches in isolation. */
export function clearRulesCache(): void {
  cache = null;
  lastLive = null;
}

/** The snapshot bundled with this build, parsed once. */
export function snapshotCatalog(): RulesCatalog {
  return (bundled ??= parseRulesCatalog(snapshot as unknown));
}

export function rulesUrl(env: EnvRecord = ambientEnv()): string {
  return `${readEnvUrl(env, ENV_VAR.docsUrl, BEEL_DEFAULTS.docsUrl)}${RULES_SOURCE.path}`;
}

async function fetchLive(url: string): Promise<RulesCatalog> {
  const response = await fetchWithTimeout(
    url,
    { headers: { accept: 'application/json' } },
    RULES_SOURCE.timeoutMs,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseRulesCatalog(JSON.parse(await readBoundedText(response, RULES_SOURCE.maxBytes)));
}

/**
 * The rules catalogue. Never throws: when the network and every cached copy
 * fail, the bundled snapshot answers, and `origin` says so.
 */
export async function loadRules(env: EnvRecord = ambientEnv()): Promise<LoadedRules> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) return { catalog: cache.catalog, origin: cache.origin };

  try {
    const catalog = await fetchLive(rulesUrl(env));
    lastLive = catalog;
    cache = { catalog, origin: 'live', expiresAt: now + CACHE_TTL_MS.rules };
  } catch {
    // Stale beats the snapshot: it came from the source and is at most minutes old.
    const origin: RulesOrigin = lastLive ? 'stale' : 'snapshot';
    cache = {
      catalog: lastLive ?? snapshotCatalog(),
      origin,
      expiresAt: now + RULES_SOURCE.retryAfterFailureMs,
    };
  }
  return { catalog: cache.catalog, origin: cache.origin };
}
