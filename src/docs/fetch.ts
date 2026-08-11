/**
 * Fetch the machine-readable docs (llms.txt index + llms-full.txt content) from
 * docs.beel.es, with a short cache. No API token is spent — these are static
 * text files. Override the source with BEEL_DOCS_URL (e.g. a local
 * `beel-api-docs-standalone` instance during development).
 *
 * The cache is in-memory (works in Node and Cloudflare Workers alike; a Worker
 * isolate keeps it warm between requests, which is all the TTL asks for).
 */

export type DocsFile = 'llms.txt' | 'llms-full.txt';

const DEFAULT_DOCS_URL = 'https://docs.beel.es';
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  text: string;
  fetchedAt: number;
}

const cache = new Map<DocsFile, CacheEntry>();

function docsBaseUrl(env: Record<string, string | undefined>): string {
  return (env.BEEL_DOCS_URL ?? DEFAULT_DOCS_URL).replace(/\/$/, '');
}

export async function fetchDocsFile(
  file: DocsFile,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): Promise<string> {
  const hit = cache.get(file);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.text;

  const url = `${docsBaseUrl(env)}/${file}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  cache.set(file, { text, fetchedAt: Date.now() });
  return text;
}
