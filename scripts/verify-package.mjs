#!/usr/bin/env node
/**
 * Verifies the package by installing it and running it.
 *
 * Whether a file exists in `dist/` says nothing about whether a consumer gets
 * it — that is decided by `files` in package.json, and the smoke test in the
 * workflow cannot tell the difference because it runs `dist/index.js` directly.
 * So this packs the tarball, installs it into a temporary directory, and drives
 * the installed binary over the protocol.
 *
 * It deliberately asks npm nothing about what it packed. An earlier version
 * parsed `npm pack --json` and broke when npm 12 changed that output's shape,
 * reporting an empty package and stopping a release for no reason. Running the
 * thing is both simpler and more honest: it fails only when a consumer would
 * actually be broken.
 *
 *   npm run verify:package
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * How many tools the installed server must expose for the contract to have
 * shipped and parsed. A count rather than a specific name: names are derived,
 * so pinning one here means this check goes stale the next time the naming
 * rules change — which it did.
 */
const MIN_TOOLS = 100;

/** The viewer resource, which the stdio server reads from disk at runtime. */
const VIEWER_URI = 'ui://beel/invoice-pdf.html';

const REQUESTS = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: VIEWER_URI } },
];

const workspace = mkdtempSync(join(tmpdir(), 'beel-mcp-verify-'));
const problems = [];

try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  // Pack and install exactly what a consumer would receive.
  const tarball = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('npm', ['install', '--silent', '--no-save', join(process.cwd(), tarball)], {
    cwd: workspace,
    stdio: 'pipe',
  });
  rmSync(tarball);

  const [binary] = Object.keys(pkg.bin ?? {});
  if (!binary) throw new Error('package.json declares no binary to run.');
  const installed = join(workspace, 'node_modules', '.bin', binary);

  const output = execFileSync('node', [installed], {
    input: REQUESTS.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 60_000,
  });

  const replies = new Map(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((m) => m.id !== undefined)
      .map((m) => [m.id, m]),
  );

  const tools = replies.get(2)?.result?.tools ?? [];
  if (tools.length < MIN_TOOLS) {
    problems.push(
      `The installed server exposes ${tools.length} tools, fewer than the ${MIN_TOOLS} expected; ` +
        'the OpenAPI contract did not ship or could not be parsed.',
    );
  }
  const oversized = tools.filter((t) => t.name.length > 40).map((t) => t.name);
  if (oversized.length > 0) {
    problems.push(`Tool names over 40 characters, which hosts may reject: ${oversized.join(', ')}`);
  }

  const viewer = replies.get(3);
  if (viewer?.error) {
    problems.push(`${VIEWER_URI} is unreadable once installed: ${viewer.error.message}`);
  }

  if (problems.length === 0) {
    console.log(`Package verified by installing it: ${tools.length} tools, viewer readable.`);
  }
} catch (err) {
  problems.push(err instanceof Error ? err.message : String(err));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error('The package a consumer would install is broken:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
