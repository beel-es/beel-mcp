#!/usr/bin/env node
/**
 * Provenance for the vendored OpenAPI contract.
 *
 * The spec in `openapi/` is a COPY of the one the API is built from. That copy is
 * the right call — it makes the tool surface deterministic per released version,
 * lets the server boot offline, and is the only way the Worker (which has no
 * filesystem) can embed it — but a copy is only trustworthy while it is provably
 * generated rather than edited. This lock file records what the copy is; CI
 * recomputes it and fails when the two disagree.
 *
 *   node scripts/spec-lock.mjs         # verify (exit 1 on mismatch)
 *   node scripts/spec-lock.mjs --write # regenerate after a legitimate sync
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const SPEC_PATH = 'openapi/public-api.yaml';
const LOCK_PATH = 'openapi/spec.lock.json';

function describeSpec() {
  const raw = readFileSync(SPEC_PATH, 'utf8');
  const doc = parse(raw);
  const operations = Object.values(doc.paths ?? {}).flatMap((item) =>
    Object.keys(item ?? {}).filter((k) => ['get', 'put', 'post', 'delete', 'patch'].includes(k)),
  );
  return {
    apiVersion: doc.info?.version ?? 'unknown',
    openapi: doc.openapi ?? 'unknown',
    operationCount: operations.length,
    schemaCount: Object.keys(doc.components?.schemas ?? {}).length,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

const actual = describeSpec();

if (process.argv.includes('--write')) {
  writeFileSync(LOCK_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Wrote ${LOCK_PATH}:`, actual);
  process.exit(0);
}

let expected;
try {
  expected = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
} catch {
  console.error(`Missing ${LOCK_PATH}. Run: node scripts/spec-lock.mjs --write`);
  process.exit(1);
}

const differences = Object.keys(actual).filter((key) => actual[key] !== expected[key]);
if (differences.length === 0) {
  console.log(`OpenAPI contract matches ${LOCK_PATH} (${actual.operationCount} operations).`);
  process.exit(0);
}

console.error(`The vendored OpenAPI contract does not match ${LOCK_PATH}:`);
for (const key of differences) {
  console.error(`  ${key}: locked ${expected[key]} → actual ${actual[key]}`);
}
console.error(
  '\nIf this came from `npm run sync:spec`, regenerate the lock in the same commit:\n' +
    '  node scripts/spec-lock.mjs --write\n' +
    'If you edited openapi/public-api.yaml by hand: do not. The contract is generated\n' +
    'from the API; a hand edit makes the tool surface lie about what the API accepts.',
);
process.exit(1);
