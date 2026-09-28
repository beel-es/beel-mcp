#!/usr/bin/env node
/**
 * Refreshes `tests/fixtures/docs-paths.json`, the list of pages the
 * documentation site publishes, read from its sitemap.
 *
 * Only tests read it: they check that every docs link this server writes for an
 * agent (guide pages, error pages, the integration guide) resolves to a
 * published page, offline. It is never edited by hand; a test asserts it is
 * byte-identical to what `formatSnapshot` produces from its own contents.
 *
 *   npm run sync:docs-index                          # from https://docs.beel.es
 *   npm run sync:docs-index -- http://localhost:3007 # from a local docs server
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_PATH = 'tests/fixtures/docs-paths.json';
export const SITEMAP_PATH = '/sitemap.xml';
const DEFAULT_DOCS_URL = 'https://docs.beel.es';

/** The one serialisation the snapshot is allowed to have: sorted, unique, one path per line. */
export function formatSnapshot(paths) {
  return `${JSON.stringify([...new Set(paths)].sort(), null, 2)}\n`;
}

/** The path of every `<loc>` in a sitemap, without a trailing slash. */
export function sitemapPaths(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => {
    const path = new URL(m[1]).pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  });
}

async function main() {
  const base = (process.argv[2] ?? process.env.BEEL_DOCS_URL ?? DEFAULT_DOCS_URL).replace(
    /\/+$/,
    '',
  );
  const url = `${base}${SITEMAP_PATH}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}`);
  const paths = sitemapPaths(await response.text());
  if (paths.length === 0) throw new Error(`${url} lists no pages.`);
  writeFileSync(SNAPSHOT_PATH, formatSnapshot(paths));
  console.log(`Wrote ${SNAPSHOT_PATH}: ${new Set(paths).size} pages from ${url}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
