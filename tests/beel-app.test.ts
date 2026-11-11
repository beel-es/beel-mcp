import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import type { ToolSurface } from '../src/policy/surface.js';
import { BEEL_APP_URI, DEFAULT_APP_ORIGIN, MCP_APP_MIME } from '../src/mcpapp/contract.js';
import { setAppHtml } from '../src/mcpapp/resource.js';
import { OPEN_APP, openAppRoute } from '../src/tools/open-app-tool.js';
import { enrichToolResult } from '../src/tools/tool-result.js';

/** The `_meta` fields these tests read off tools and resource contents. */
interface AppMeta {
  ui?: {
    resourceUri?: string;
    preferredDisplayMode?: string;
    prefersBorder?: boolean;
    csp?: { connectDomains: string[]; resourceDomains: string[] };
  };
  'openai/ui'?: { entrypoints: unknown[] };
}

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

describe('beel_open_app', () => {
  it('is a global entry point on the full surface, as Claude lists apps', async () => {
    const { tools } = await (await connect('full')).listTools();
    const tool = tools.find((t) => t.name === OPEN_APP);
    expect(tool).toBeDefined();
    const meta = tool!._meta as AppMeta;
    expect(meta.ui?.resourceUri).toBe(BEEL_APP_URI);
    expect(meta['openai/ui']?.entrypoints).toEqual([{ type: 'global' }]);
    // The host refuses a listed app whose title is long or whose name has these.
    expect(tool!.title!.length).toBeLessThanOrEqual(60);
    expect(tool!.name).not.toMatch(/__|\.\.|\._|_\./);
    // Opened from the apps page with no arguments, so nothing may be required.
    expect(tool!.inputSchema.required ?? []).toEqual([]);
  });

  it('stays off the ChatGPT surface, listed and called', async () => {
    const client = await connect('chatgpt');
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === OPEN_APP)).toBe(false);
    const result = await client.callTool({ name: OPEN_APP, arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('opens on home with no arguments and routes to what it is given', async () => {
    const client = await connect('full');
    const home = await client.callTool({ name: OPEN_APP, arguments: {} });
    expect(home.isError).toBeFalsy();
    expect(home.structuredContent).toEqual({ view: 'home' });

    const invoice = await client.callTool({
      name: OPEN_APP,
      arguments: { invoice_id: 'inv_1', company_id: 'co_1' },
    });
    expect(invoice.structuredContent).toEqual({
      view: 'invoice',
      invoice_id: 'inv_1',
      company_id: 'co_1',
    });

    const bad = await client.callTool({ name: OPEN_APP, arguments: { view: 'settings' } });
    expect(bad.isError).toBe(true);
  });

  it('falls back to the list when asked for an invoice without its id', () => {
    expect(openAppRoute({ view: 'invoice' })).toEqual({ view: 'invoices' });
    expect(openAppRoute({ view: 'customers', search: 'acme' })).toEqual({
      view: 'customers',
      search: 'acme',
    });
  });
});

describe('BeeL. app binding', () => {
  it('creating an invoice opens the app on the full surface only', async () => {
    const full = (await (await connect('full')).listTools()).tools;
    const chatgpt = (await (await connect('chatgpt')).listTools()).tools;
    const create = (tools: typeof full) => tools.find((t) => t.name === 'beel_create_invoice');
    expect((create(full)?._meta as AppMeta | undefined)?.ui?.resourceUri).toBe(BEEL_APP_URI);
    expect((create(chatgpt)?._meta as AppMeta | undefined)?.ui?.resourceUri).toBeUndefined();
  });

  it('a created invoice keeps its JSON and adds the route to it', async () => {
    const invoice = { id: 'inv_9', status: 'DRAFT', totals: { invoice_total: 121 } };
    const result = await enrichToolResult('createCompanyInvoice', invoice);
    expect(result?.structuredContent).toEqual({ view: 'invoice', invoice_id: 'inv_9' });
    expect(result?.content).toEqual([{ type: 'text', text: JSON.stringify(invoice) }]);
    expect(await enrichToolResult('createCompanyInvoice', { status: 'DRAFT' })).toBeNull();
  });
});

describe('BeeL. app resource', () => {
  it('is listed and served as an MCP App that asks for the side panel', async () => {
    setAppHtml(BEEL_APP_URI, '<!DOCTYPE html><html><head></head><body></body></html>');
    const client = await connect('full');
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === BEEL_APP_URI)).toBe(true);

    const { contents } = await client.readResource({ uri: BEEL_APP_URI });
    const [content] = contents as Array<{ mimeType?: string; text?: string; _meta: AppMeta }>;
    expect(content!.mimeType).toBe(MCP_APP_MIME);
    expect(content!.text).toContain('http-equiv="Content-Security-Policy"');
    expect(content!._meta.ui?.preferredDisplayMode).toBe('fullscreen');
    expect(content!._meta.ui?.prefersBorder).toBe(false);
    expect(content!._meta.ui?.csp?.connectDomains.length).toBeGreaterThan(0);
    // The brand fonts load from the server's own origin, so it is a resource domain.
    expect(content!._meta.ui?.csp?.resourceDomains).toContain(DEFAULT_APP_ORIGIN);
  });
});
