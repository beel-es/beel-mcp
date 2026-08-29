#!/usr/bin/env node
/**
 * Re-bundle the embedded OpenAPI spec from the backend source.
 *
 * The MCP server interprets the spec at runtime, so keeping openapi/public-api.yaml
 * in sync with the backend is the whole maintenance story. This script bundles the
 * multi-file source into a single file *keeping internal $refs* (NOT dereferenced):
 * a fully dereferenced bundle produces a YAML-alias explosion that trips the parser.
 *
 * Usage:
 *   node scripts/bundle-spec.mjs [path-to-backend-openapi/public-api.yaml]
 *
 * The source is a checkout of the contract source, which lives outside this
 * repository. Pass its path as the first argument or set BEEL_BACKEND_PATH; the
 * default is a sibling checkout. In CI the source is checked out first (see
 * .github/workflows/sync-spec.yml).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../openapi/public-api.yaml');

const DEFAULT_SOURCE = resolve(
  here,
  // Sibling checkout of the contract source. Override with BEEL_BACKEND_PATH.
  process.env.BEEL_BACKEND_PATH ?? '../../backend/src/main/resources/openapi/public-api.yaml',
);

const source = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SOURCE;

if (!existsSync(source)) {
  console.error(`Spec source not found: ${source}`);
  console.error(
    'Pass the path to the contract source public-api.yaml as the first argument, ' +
      'or set BEEL_BACKEND_PATH.',
  );
  process.exit(1);
}

console.error(`Bundling ${source} -> ${OUT}`);
// The installed @redocly/cli, never a floating `npx -y @redocly/cli@latest`: the
// bundler's output is what CI locks with spec-lock, so the tool that produces it
// has to be pinned by package-lock.json like any other build input.
const redocly = resolve(here, '../node_modules/.bin/redocly');
if (!existsSync(redocly)) {
  console.error('@redocly/cli is not installed. Run `npm ci` first.');
  process.exit(1);
}
execFileSync(redocly, ['bundle', source, '-o', OUT], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
console.error('Done. Review the diff and run `npm test` before publishing.');
