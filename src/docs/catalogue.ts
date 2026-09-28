/**
 * A JSON catalogue the docs site publishes (the fiscal rules, the official
 * SDKs), loaded with an in-memory cache that works in Node and in a Worker
 * isolate alike.
 *
 * Order of preference: a fresh copy, then a stale copy from an earlier fetch,
 * then the snapshot bundled at build time. The snapshot exists so the tools
 * answer when the docs host is unreachable; it is written only by its sync
 * script and is never the primary source.
 */

import { BEEL_DEFAULTS, ENV_VAR } from '../shared/defaults.js';
import { ambientEnv, readEnvUrl, type EnvRecord } from '../shared/env.js';
import { fetchWithTimeout, readBoundedText } from '../shared/fetch.js';

/** Where the catalogue in hand came from. */
export type CatalogueOrigin = 'live' | 'stale' | 'snapshot';

export interface LoadedCatalogue<T> {
  catalog: T;
  origin: CatalogueOrigin;
}

export interface CatalogueSource<T> {
  /** Path under the docs base URL, e.g. `/api/rules.json`. */
  path: string;
  /** Deadline for one fetch. */
  timeoutMs: number;
  /** Largest body accepted; anything far past the real size is not the catalogue. */
  maxBytes: number;
  /** How long a live copy is served before it is fetched again. */
  ttlMs: number;
  /** After a failed fetch, how long the fallback is served before trying again. */
  retryAfterFailureMs: number;
  /** Checks the shape and returns it typed, or throws. */
  parse: (doc: unknown) => T;
  /** The bundled copy, as imported JSON. */
  snapshot: unknown;
}

export interface CatalogueLoader<T> {
  /** The catalogue. Never throws: the snapshot answers when nothing else does. */
  load(env?: EnvRecord): Promise<LoadedCatalogue<T>>;
  /** The bundled snapshot, parsed once. */
  snapshot(): T;
  /** The URL it is read from, under `BEEL_DOCS_URL` when that is set. */
  url(env?: EnvRecord): string;
  /** Drop the cache. Tests use it to observe fetches in isolation. */
  clear(): void;
}

interface CacheEntry<T> {
  catalog: T;
  origin: CatalogueOrigin;
  /** When this entry stops being served without trying the network again. */
  expiresAt: number;
}

export function createCatalogueLoader<T>(source: CatalogueSource<T>): CatalogueLoader<T> {
  let cache: CacheEntry<T> | null = null;
  /** The last copy that came from the network, kept to serve stale over the snapshot. */
  let lastLive: T | null = null;
  let bundled: T | null = null;

  const snapshot = (): T => (bundled ??= source.parse(source.snapshot));
  const url = (env: EnvRecord = ambientEnv()): string =>
    `${readEnvUrl(env, ENV_VAR.docsUrl, BEEL_DEFAULTS.docsUrl)}${source.path}`;

  async function fetchLive(target: string): Promise<T> {
    const response = await fetchWithTimeout(
      target,
      { headers: { accept: 'application/json' } },
      source.timeoutMs,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return source.parse(JSON.parse(await readBoundedText(response, source.maxBytes)));
  }

  async function load(env: EnvRecord = ambientEnv()): Promise<LoadedCatalogue<T>> {
    const now = Date.now();
    if (cache && now < cache.expiresAt) return { catalog: cache.catalog, origin: cache.origin };
    try {
      const catalog = await fetchLive(url(env));
      lastLive = catalog;
      cache = { catalog, origin: 'live', expiresAt: now + source.ttlMs };
    } catch {
      // Stale beats the snapshot: it came from the source and is at most minutes old.
      cache = {
        catalog: lastLive ?? snapshot(),
        origin: lastLive ? 'stale' : 'snapshot',
        expiresAt: now + source.retryAfterFailureMs,
      };
    }
    return { catalog: cache.catalog, origin: cache.origin };
  }

  return {
    load,
    snapshot,
    url,
    clear: () => {
      cache = null;
      lastLive = null;
    },
  };
}
