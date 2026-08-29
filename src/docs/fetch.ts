/**
 * Fetch the machine-readable docs (llms.txt index + llms-full.txt content) from
 * docs.beel.es, with a short cache. No API token is spent — these are static
 * text files. Override the source with BEEL_DOCS_URL (e.g. a local docs
 * instance during development).
 *
 * The cache is in-memory (works in Node and Cloudflare Workers alike; a Worker
 * isolate keeps it warm between requests, which is all the TTL asks for).
 */

import { BEEL_DEFAULTS, CACHE_TTL_MS, ENV_VAR, HTTP_DEFAULTS } from '../shared/defaults.js';
import { ambientEnv, readEnvInt, readEnvUrl, type EnvRecord } from '../shared/env.js';
import { fetchWithTimeout, readBoundedText } from '../shared/fetch.js';

export type DocsFile = 'llms.txt' | 'llms-full.txt';

/**
 * Ceiling on a documentation file. These are prose bundles of a few hundred
 * kilobytes; anything past this is not the file we asked for, and reading it
 * would spend the model's context before anyone could notice.
 */
export const MAX_DOCS_BYTES = 1024 * 1024;

interface CacheEntry {
  text: string;
  fetchedAt: number;
}

const cache = new Map<DocsFile, CacheEntry>();

/** Drop every cached file. Tests use it to observe fetches in isolation. */
export function clearDocsCache(): void {
  cache.clear();
}

function docsBaseUrl(env: EnvRecord): string {
  return readEnvUrl(env, ENV_VAR.docsUrl, BEEL_DEFAULTS.docsUrl);
}

/**
 * Read a documentation file, preferring a fresh copy and falling back to a stale
 * one.
 *
 * Serving a stale copy beats failing the tool call: the docs change on the scale
 * of releases, so a copy minutes past its TTL is still correct, and the
 * alternative is an agent composing a fiscal payload with no guidance at all.
 * With nothing cached the failure propagates — an empty string would read as
 * "the documentation says nothing about this".
 */
export async function fetchDocsFile(
  file: DocsFile,
  env: EnvRecord = ambientEnv(),
): Promise<string> {
  const hit = cache.get(file);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS.docs) return hit.text;

  const url = `${docsBaseUrl(env)}/${file}`;
  const timeoutMs = readEnvInt(env, ENV_VAR.requestTimeoutMs, HTTP_DEFAULTS.timeoutMs);
  try {
    const response = await fetchWithTimeout(url, { headers: { accept: 'text/plain' } }, timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await readBoundedText(response, MAX_DOCS_BYTES);
    cache.set(file, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    if (hit) return hit.text;
    throw new Error(`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
