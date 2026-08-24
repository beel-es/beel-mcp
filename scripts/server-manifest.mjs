#!/usr/bin/env node
/**
 * Keeps `server.json` — the MCP Registry manifest — in step with `package.json`.
 *
 * The registry refuses to republish a version it already holds, and a release
 * here is `npm version && git push --follow-tags`: npm bumps `package.json` and
 * nothing else. Left to itself, `server.json` would still claim the previous
 * version by the second release, and the publish step would fail at the end of
 * the pipeline — after npm had already gone out. So the version is derived, not
 * typed, and CI recomputes it.
 *
 * Only the version fields are generated. Everything else in `server.json` —
 * name, transports, environment variables — is hand-written, because it is a
 * public contract and not something to infer.
 *
 *   node scripts/server-manifest.mjs         # verify (exit 1 on drift)
 *   node scripts/server-manifest.mjs --write # rewrite after a version bump
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFEST_PATH = 'server.json';
const PACKAGE_PATH = 'package.json';

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

/** Every place the released version has to appear, in one list. */
function versionSites(doc) {
  return [
    { where: 'version', get: () => doc.version, set: (v) => { doc.version = v; } },
    ...(doc.packages ?? []).map((p, i) => ({
      where: `packages[${i}].version`,
      get: () => p.version,
      set: (v) => { p.version = v; },
    })),
  ];
}

// The npm package the manifest points at must be the one this repo publishes;
// a manifest advertising someone else's package is worse than none at all.
const npmPackage = (manifest.packages ?? []).find((p) => p.registryType === 'npm');
if (npmPackage && npmPackage.identifier !== pkg.name) {
  console.error(
    `::error::server.json points at npm package "${npmPackage.identifier}" but this repo publishes "${pkg.name}".`,
  );
  process.exit(1);
}

const sites = versionSites(manifest);

if (process.argv.includes('--write')) {
  sites.forEach((site) => site.set(pkg.version));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${MANIFEST_PATH} at version ${pkg.version}.`);
  process.exit(0);
}

const drifted = sites.filter((site) => site.get() !== pkg.version);

if (drifted.length > 0) {
  console.error(`::error::${MANIFEST_PATH} is out of step with ${PACKAGE_PATH} (${pkg.version}):`);
  drifted.forEach((site) => console.error(`  ${site.where} = ${site.get()}`));
  console.error("Run 'npm run manifest:write' and commit the result.");
  process.exit(1);
}

console.log(`${MANIFEST_PATH} matches ${PACKAGE_PATH} at version ${pkg.version}.`);
