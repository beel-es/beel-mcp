#!/usr/bin/env node
/**
 * Verifies what would actually ship to npm, after a build.
 *
 * This is deliberately not a unit test: it inspects build output and the packed
 * tarball, so it only means anything once `npm run build` has run. Wiring it
 * into the pipelines instead keeps the test suite runnable without a build,
 * while still failing loudly when the package is wrong — which is the failure
 * nobody notices until someone runs the published binary.
 *
 *   npm run verify:package
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const problems = [];

// The binary is what `npx @beel_es/mcp` executes.
for (const [name, target] of Object.entries(pkg.bin ?? {})) {
  const path = target.replace(/^\.\//, '');
  if (!existsSync(path)) {
    problems.push(`bin "${name}" points at ${path}, which the build did not produce.`);
    continue;
  }
  if (!readFileSync(path, 'utf8').startsWith('#!')) {
    problems.push(`${path} has no shebang, so npx cannot execute it.`);
  }
}

// The stdio server reads the viewer from disk at runtime. The Worker embeds the
// same file as a text module, so only the npm package notices when it is absent.
const VIEWER = 'dist/mcpapp/invoice-pdf.html';
if (!existsSync(VIEWER)) {
  problems.push(`${VIEWER} is missing. The bundler wipes dist/, so it must be built after it.`);
}

// Ask npm what the tarball would contain, rather than assuming `files` is right.
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
const shipped = new Set((packed[0]?.files ?? []).map((f) => f.path));

for (const required of ['dist/index.js', VIEWER, 'openapi/public-api.yaml', 'LICENSE', 'README.md']) {
  if (!shipped.has(required)) problems.push(`${required} would not be published.`);
}
for (const path of shipped) {
  if (/^(src|tests|scripts|\.github)\//.test(path)) {
    problems.push(`${path} would be published, and has no business in a consumer's node_modules.`);
  }
}

if (problems.length > 0) {
  console.error('The package that would be published is wrong:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const size = Math.round((packed[0]?.size ?? 0) / 1024);
console.log(`Package verified: ${shipped.size} files, ${size} kB packed.`);
