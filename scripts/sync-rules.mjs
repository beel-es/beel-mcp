#!/usr/bin/env node
/**
 * Refreshes `src/rules/snapshot.json`, the copy of the fiscal rules catalogue
 * bundled with the server.
 *
 * The catalogue is published by the documentation site at `/api/rules.json`, and
 * the server reads it from there at runtime. The snapshot is only what it falls
 * back to when that fetch fails, so the tools still answer offline. It is never
 * edited by hand: this script is the only writer, and a test asserts the file is
 * byte-identical to what `formatSnapshot` produces from its own contents.
 *
 *   npm run sync:rules                       # from https://docs.beel.es
 *   npm run sync:rules -- http://localhost:3007   # from a local docs server
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_PATH = 'src/rules/snapshot.json';
export const RULES_PATH = '/api/rules.json';
const DEFAULT_DOCS_URL = 'https://docs.beel.es';

/** The one serialisation the snapshot is allowed to have. */
export function formatSnapshot(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

async function main() {
  const base = (process.argv[2] ?? process.env.BEEL_DOCS_URL ?? DEFAULT_DOCS_URL).replace(
    /\/+$/,
    '',
  );
  const url = `${base}${RULES_PATH}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}`);
  const catalog = await response.json();
  if (!Array.isArray(catalog?.rules) || !Array.isArray(catalog?.domains)) {
    throw new Error(`${url} is not a rules catalogue: expected "rules" and "domains" arrays.`);
  }
  writeFileSync(SNAPSHOT_PATH, formatSnapshot(catalog));
  console.log(
    `Wrote ${SNAPSHOT_PATH}: ${catalog.rules.length} rules in ${catalog.domains.length} domains from ${url}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
