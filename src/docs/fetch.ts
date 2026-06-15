import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Fetch the machine-readable docs (llms.txt index + llms-full.txt content) from
 * docs.beel.es, with a short on-disk cache. No API token is spent — these are
 * static text files. Override the source with BEEL_DOCS_URL (e.g. a local
 * `beel-api-docs-standalone` instance during development).
 */

export type DocsFile = 'llms.txt' | 'llms-full.txt';

const DEFAULT_DOCS_URL = 'https://docs.beel.es';
const CACHE_TTL_MS = 15 * 60 * 1000;

function docsBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.BEEL_DOCS_URL ?? DEFAULT_DOCS_URL).replace(/\/$/, '');
}

function cacheDir(): string {
  const dir = join(tmpdir(), 'beel-mcp-docs-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export async function fetchDocsFile(
  file: DocsFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const cachePath = join(cacheDir(), file);
  if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < CACHE_TTL_MS) {
    return readFileSync(cachePath, 'utf8');
  }
  const url = `${docsBaseUrl(env)}/${file}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  writeFileSync(cachePath, text);
  return text;
}
