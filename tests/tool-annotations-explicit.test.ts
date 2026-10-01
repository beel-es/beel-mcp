import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

/**
 * OpenAI's plugin portal refuses to submit a server while any tool leaves one of
 * these hints unset, even where the MCP spec would let a client infer it (a
 * read-only tool is never destructive). Hand-written tools are the ones that
 * drift: the generated ones get all three from `annotationsFor`.
 */
const REQUIRED_HINTS = ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const;

describe('tool annotations', () => {
  it('every tool sets each safety hint explicitly as a boolean', async () => {
    const server = createServer({ name: 'test', version: '0' }, { quiet: true });
    const client = new Client({ name: 'test-client', version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const { tools } = await client.listTools();
    const missing = tools.flatMap((tool) =>
      REQUIRED_HINTS.filter((hint) => typeof tool.annotations?.[hint] !== 'boolean').map(
        (hint) => `${tool.name}.${hint}`,
      ),
    );
    expect(missing).toEqual([]);
    await client.close();
  });
});
