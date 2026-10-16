import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import {
  apiToolsFor,
  CHATGPT_EXCLUDED_OPERATION_IDS,
  CHATGPT_EXCLUDED_TAGS,
  CHATGPT_REDACTED_PROPERTIES,
  surfaceForClient,
  type ToolSurface,
} from '../src/policy/surface.js';

const { tools: apiTools } = buildApiTools();

async function connect(surface: ToolSurface): Promise<Client> {
  const server = createServer(
    { name: 'test', version: '0' },
    { quiet: true, getSurface: () => surface },
  );
  const client = new Client({ name: 'test-client', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** Every property name anywhere in a schema, `$defs` included. */
function propertyNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => propertyNames(n, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const name of Object.keys(value)) out.add(name);
      }
      propertyNames(value, out);
    }
  }
  return out;
}

describe('chatgpt surface', () => {
  const chatgpt = apiToolsFor(apiTools, 'chatgpt');

  it('leaves the full surface untouched', () => {
    expect(apiToolsFor(apiTools, 'full')).toBe(apiTools);
  });

  it('names only tags and operations that exist', () => {
    const tags = new Set(apiTools.flatMap((t) => t.operation.tags));
    const ids = new Set(apiTools.map((t) => t.operation.operationId));
    expect([...CHATGPT_EXCLUDED_TAGS].filter((t) => !tags.has(t))).toEqual([]);
    expect([...CHATGPT_EXCLUDED_OPERATION_IDS].filter((id) => !ids.has(id))).toEqual([]);
  });

  it('drops credential, people-administration, representation and payment-provider tools', () => {
    const names = new Set(chatgpt.map((t) => t.tool.name));
    for (const name of [
      'beel_create_webhook_subscription',
      'beel_rotate_webhook_secret',
      'beel_create_claim_token',
      'beel_provision_account',
      'beel_list_request_logs',
      'beel_create_invitation',
      'beel_list_members',
      'beel_generate_representation',
      'beel_initiate_payment_connection',
      'beel_list_payment_events',
    ]) {
      expect(names.has(name), name).toBe(false);
    }
    // The invoicing function stays whole.
    for (const name of [
      'beel_create_invoice',
      'beel_issue_invoice',
      'beel_create_customer',
      'beel_validate_nif',
      'beel_send_invoice',
      'beel_get_fiscal_summary',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('asks for no bank account and no legal representative anywhere', () => {
    const leaks = chatgpt.flatMap((t) =>
      [...propertyNames(t.tool.inputSchema)]
        .filter((p) => CHATGPT_REDACTED_PROPERTIES.has(p))
        .map((p) => `${t.tool.name}.${p}`),
    );
    expect(leaks).toEqual([]);
    // The redaction is not vacuous: the full surface does ask for them.
    expect(apiTools.some((t) => propertyNames(t.tool.inputSchema).has('iban'))).toBe(true);
  });

  it('keeps the customer NIF, which a full invoice requires', () => {
    const create = chatgpt.find((t) => t.tool.name === 'beel_create_customer')!;
    expect(propertyNames(create.tool.inputSchema).has('nif')).toBe(true);
  });

  it('hides the excluded tools from a session and refuses to call them', async () => {
    const client = await connect('chatgpt');
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === 'beel_rotate_webhook_secret')).toBe(false);
    expect(tools.some((t) => t.name === 'beel_docs_search')).toBe(true);

    const result = await client.callTool({ name: 'beel_create_claim_token', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Unknown tool');
    await client.close();
  });

  it('rejects a redacted field instead of forwarding it', async () => {
    const client = await connect('chatgpt');
    const result = await client.callTool({
      name: 'beel_patch_company',
      arguments: {
        company_id: '00000000-0000-0000-0000-000000000000',
        body: { default_iban: 'ES9121000418450200051332' },
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('default_iban');
    await client.close();
  });
});

describe('surfaceForClient', () => {
  it('puts only a verified ChatGPT callback on the chatgpt surface', () => {
    expect(surfaceForClient({ verified: true, origin: 'chatgpt.com' })).toBe('chatgpt');
    expect(surfaceForClient({ verified: false, origin: 'chatgpt.com' })).toBe('full');
    expect(surfaceForClient({ verified: true, origin: 'claude.ai' })).toBe('full');
    expect(surfaceForClient({ verified: false })).toBe('full');
  });
});
