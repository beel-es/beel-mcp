#!/usr/bin/env node
/**
 * Verifies what would actually ship to npm, after a build.
 *
 * Deliberately not a unit test: it inspects build output and the packed tarball,
 * so it only means anything once `npm run build` has run. Wiring it into the
 * pipelines instead keeps the test suite runnable without a build, while still
 * failing when the package is wrong — the failure nobody notices until someone
 * runs the published binary.
 *
 *   npm run verify:package
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** The stdio server reads this from disk; the Worker embeds it at bundle time. */
const VIEWER = 'dist/mcpapp/invoice-pdf.html';

/** Everything a consumer needs, and would be broken without. */
const REQUIRED = ['dist/index.js', VIEWER, 'openapi/public-api.yaml', 'LICENSE', 'README.md'];

/** Directories that belong to the repository, never to a consumer's node_modules. */
const REPOSITORY_ONLY = /^(src|tests|scripts|\.github)\//;

/**
 * Pull the single package entry out of `npm pack --json`.
 *
 * The shape changed in npm 12: a one-element array became an object keyed by
 * package name. Reading it blindly makes this check report that *nothing* would
 * be published — alarming, and completely wrong. Accept both, and throw rather
 * than treat an unrecognised shape as an empty package.
 */
export function readPackedEntry(parsed) {
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed ?? {})[0];
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(
      'Could not read the file list from `npm pack --json`. Its output shape may have changed again.',
    );
  }
  return entry;
}

/** Everything wrong with the package as it stands, in the order found. */
export function findProblems(pkg, shipped) {
  const problems = [];

  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    // npm rewrites a bin path beginning with "./" and warns that it had to
    // correct the manifest — a warning on every single publish otherwise.
    if (target.startsWith('./')) {
      problems.push(`bin "${name}" is "${target}"; npm will rewrite it. Drop the leading "./".`);
    }
    const path = target.replace(/^\.\//, '');
    if (!existsSync(path)) {
      problems.push(`bin "${name}" points at ${path}, which the build did not produce.`);
    } else if (!readFileSync(path, 'utf8').startsWith('#!')) {
      problems.push(`${path} has no shebang, so npx cannot execute it.`);
    }
  }

  if (!existsSync(VIEWER)) {
    problems.push(`${VIEWER} is missing. The bundler wipes dist/, so it must be built after it.`);
  }

  for (const required of REQUIRED) {
    if (!shipped.has(required)) problems.push(`${required} would not be published.`);
  }
  for (const path of shipped) {
    if (REPOSITORY_ONLY.test(path)) {
      problems.push(`${path} would be published, and belongs only in the repository.`);
    }
  }

  return problems;
}

function main() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  const entry = readPackedEntry(JSON.parse(raw));
  const shipped = new Set(entry.files.map((f) => f.path));

  const problems = findProblems(pkg, shipped);
  if (problems.length > 0) {
    console.error('The package that would be published is wrong:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`Package verified: ${shipped.size} files, ${Math.round((entry.size ?? 0) / 1024)} kB packed.`);
}

// Run the checks only when invoked directly; the test suite imports the helpers.
if (process.argv[1]?.endsWith('verify-package.mjs')) main();
