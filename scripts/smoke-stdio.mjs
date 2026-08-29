#!/usr/bin/env node
/**
 * Boots the built stdio server and asserts it lists its tools.
 *
 * The single definition of "the server works at all": it must complete the MCP
 * handshake and answer tools/list with no credentials configured, because that
 * is what a host does before a user has entered anything. Both CI and the
 * release run this, so the two can never drift into checking different things.
 *
 * Tools are matched by shape rather than by an exact name: names are derived from
 * the contract, so pinning one here goes stale whenever the naming rules change.
 *
 *   npm run smoke [-- path/to/index.js]
 */
import { spawnSync } from 'node:child_process';

const ENTRY = process.argv[2] ?? 'dist/index.js';
const TIMEOUT_MS = 20_000;

/** Any invoice tool proves the contract shipped, parsed and produced a tool surface. */
const EXPECTED_TOOL = /^beel_[a-z_]+_invoice$/;

const REQUESTS = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

function fail(message, detail) {
  console.error(`Smoke test failed: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const run = spawnSync('node', [ENTRY], {
  input: `${REQUESTS.map((r) => JSON.stringify(r)).join('\n')}\n`,
  encoding: 'utf8',
  timeout: TIMEOUT_MS,
});

if (run.error) fail(`could not run ${ENTRY}: ${run.error.message}`);
if (run.status !== 0 && run.status !== null) {
  fail(`${ENTRY} exited with code ${run.status}`, run.stderr);
}

const replies = [];
for (const line of run.stdout.split('\n')) {
  if (!line.trim()) continue;
  try {
    replies.push(JSON.parse(line));
  } catch {
    fail('the server wrote a non-JSON line to stdout, which corrupts the transport', line);
  }
}

const list = replies.find((m) => m.id === 2);
if (!list) fail('the server never answered tools/list', run.stderr);
if (list.error) fail(`tools/list returned an error: ${list.error.message}`);

const names = (list.result?.tools ?? []).map((t) => t.name);
if (!names.some((name) => EXPECTED_TOOL.test(name))) {
  fail(
    `none of the ${names.length} tools matches ${EXPECTED_TOOL}; the OpenAPI contract did not ship or could not be parsed`,
  );
}

console.log(`tools/list OK — ${names.length} tools from ${ENTRY}.`);
