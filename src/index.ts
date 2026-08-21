#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { SERVER_INFO, SERVER_NAME } from './shared/defaults.js';

async function main(): Promise<void> {
  const server = createServer(SERVER_INFO);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server now runs over stdio until the client disconnects.
}

main().catch((err) => {
  process.stderr.write(
    `[${SERVER_NAME}] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
