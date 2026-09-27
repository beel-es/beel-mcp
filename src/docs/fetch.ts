/**
 * Read from docs.beel.es: the search endpoint, one page's Markdown, and the
 * llms.txt index. Each is a small response — a search answers a few KB and a
 * page a few more — so nothing here downloads the whole documentation. No API
 * token is spent. Override the host with BEEL_DOCS_URL (e.g. a local docs
 * instance during development).
 *
 * The cache is in-memory (works in Node and Cloudflare Workers alike; a Worker
 * isolate keeps it warm between requests, which is all the TTL asks for).
 */

import { BEEL_DEFAULTS, CACHE_TTL_MS, ENV_VAR, HTTP_DEFAULTS } from '../shared/defaults.js';
import { ambientEnv, readEnvInt, readEnvUrl, type EnvRecord } from '../shared/env.js';
import { fetchWithTimeout, readBoundedText } from '../shared/fetch.js';

/**
 * Ceiling on any one response. A search result or a page is a few KB, the index
 * a few dozen; anything past this is not what we asked for, and reading it would
 * spend the model's context before anyone could notice.
 */
export const MAX_DOCS_BYTES = 1024 * 1024;

/** How many distinct responses the cache keeps; the oldest goes first. */
const CACHE_ENTRIES = 200;

interface CacheEntry {
  text: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop every cached response. Tests use it to observe fetches in isolation. */
export function clearDocsCache(): void {
  cache.clear();
}

export function docsBaseUrl(env: EnvRecord = ambientEnv()): string {
  return readEnvUrl(env, ENV_VAR.docsUrl, BEEL_DEFAULTS.docsUrl);
}

/** Raised when the docs host answers but says no: a 404 page, a 400 query. */
export class DocsHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DocsHttpError';
  }
}

/**
 * Read `path` (with its query string) from the docs host, preferring a fresh copy
 * and falling back to a stale one.
 *
 * Serving a stale copy beats failing the tool call: the docs change on the scale
 * of releases. A 4xx is not an outage and is never masked by a stale copy — it
 * surfaces with the host's own message, which says what was wrong. With nothing
 * cached, any other failure propagates: an empty string would read as "the
 * documentation says nothing about this".
 */
export async function fetchDocs(path: string, env: EnvRecord = ambientEnv()): Promise<string> {
  const url = `${docsBaseUrl(env)}${path.startsWith('/') ? '' : '/'}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS.docs) return hit.text;

  const timeoutMs = readEnvInt(env, ENV_VAR.requestTimeoutMs, HTTP_DEFAULTS.timeoutMs);
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {}, timeoutMs);
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    if (hit) return hit.text;
    throw new Error(`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (!response.ok) {
    throw new DocsHttpError(response.status, await errorMessage(response, url));
  }
  try {
    const text = await readBoundedText(response, MAX_DOCS_BYTES);
    cache.delete(url);
    cache.set(url, { text, fetchedAt: Date.now() });
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return text;
  } catch (err) {
    if (hit) return hit.text;
    throw new Error(`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

/** The `error` of a JSON error body, or the status. */
async function errorMessage(response: Response, url: string): Promise<string> {
  try {
    const body = JSON.parse(await readBoundedText(response, 16 * 1024)) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON: an HTML 404 page, say. The status is the message.
  }
  return `HTTP ${response.status} from ${url}`;
}
