#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// `require` is injected by the tsup banner (createRequire); resolves the published package.json.
const { version } = require('../package.json') as { version: string };

async function main(): Promise<void> {
  const server = createServer({ name: 'beel-mcp', version });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server now runs over stdio until the client disconnects.
}

main().catch((err) => {
  process.stderr.write(`[beel-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
