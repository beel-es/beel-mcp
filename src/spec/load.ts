import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The bundled OpenAPI document, parsed once.
 *
 * The spec ships inside the package (see `files` in package.json) and is read
 * from disk at startup. We probe a couple of candidate locations so the same
 * code works whether it runs from `dist/index.js` (published bundle) or from
 * `src/spec/load.ts` under tsx during development.
 */
const SPEC_RELATIVE_CANDIDATES = [
  '../openapi/public-api.yaml', // from dist/index.js
  '../../openapi/public-api.yaml', // from src/spec/load.ts (dev)
];

export type SpecNode = Record<string, unknown>;

function resolveSpecPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of SPEC_RELATIVE_CANDIDATES) {
    const path = resolve(here, candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(
    `Could not locate openapi/public-api.yaml relative to ${here}. ` +
      'Make sure the openapi/ directory ships with the package.',
  );
}

let cached: SpecNode | null = null;

/** Parse and memoise the embedded OpenAPI document. */
export function loadSpec(): SpecNode {
  if (cached) return cached;
  const raw = readFileSync(resolveSpecPath(), 'utf8');
  cached = parse(raw) as SpecNode;
  return cached;
}
