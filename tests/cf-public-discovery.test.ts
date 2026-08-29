import { describe, expect, it } from 'vitest';
import {
  handlePublicDiscovery,
  isPublicDiscoveryCandidate,
  publicDiscoveryEnabled,
  publicMethodOf,
} from '../src/cf/public-discovery.js';
import { advertisedScopes, SANDBOX_SCOPE } from '../src/policy/scopes.js';
import { specScopes } from '../src/spec/scopes.js';
import { SERVER_NAME } from '../src/shared/defaults.js';
import { appCsp, appCspMeta, INVOICE_PDF_APP_URI, MCP_APP_MIME } from '../src/mcpapp/contract.js';
import { withCspMeta } from '../src/mcpapp/resource.js';

const MCP = 'https://mcp.beel.es/mcp';

function rpc(method: string, params: Record<string, unknown> = {}, init: RequestInit = {}) {
  return new Request(MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(init.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('public discovery switch', () => {
  it('is off unless the variable is exactly "true"', () => {
    expect(publicDiscoveryEnabled({})).toBe(false);
    expect(publicDiscoveryEnabled({ MCP_PUBLIC_DISCOVERY: 'yes' })).toBe(false);
    expect(publicDiscoveryEnabled({ MCP_PUBLIC_DISCOVERY: 'true' })).toBe(true);
  });

  it('only considers token-less POSTs to the MCP endpoint', () => {
    expect(isPublicDiscoveryCandidate(rpc('initialize'))).toBe(true);
    expect(
      isPublicDiscoveryCandidate(rpc('initialize', {}, { headers: { Authorization: 'Bearer x' } })),
    ).toBe(false);
    expect(isPublicDiscoveryCandidate(new Request(MCP, { method: 'GET' }))).toBe(false);
    expect(
      isPublicDiscoveryCandidate(new Request('https://mcp.beel.es/token', { method: 'POST' })),
    ).toBe(false);
  });

  it('accepts the list methods and nothing that touches data', async () => {
    expect(await publicMethodOf(rpc('initialize'))).toBe('initialize');
    expect(await publicMethodOf(rpc('tools/list'))).toBe('tools/list');
    expect(await publicMethodOf(rpc('tools/call', { name: 'x' }))).toBeNull();
    expect(await publicMethodOf(rpc('resources/subscribe'))).toBeNull();
    const batch = new Request(MCP, { method: 'POST', body: '[{"method":"tools/list"}]' });
    expect(await publicMethodOf(batch)).toBeNull();
    const broken = new Request(MCP, { method: 'POST', body: '{' });
    expect(await publicMethodOf(broken)).toBeNull();
  });
});

describe('public discovery responses', () => {
  it('answers initialize without a token and without a session', async () => {
    const response = await handlePublicDiscovery(
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'audit', version: '0' },
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get('mcp-session-id')).toBeNull();
    const body = (await response!.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe(SERVER_NAME);
  });

  it('lists the tools with their schemas', async () => {
    const response = await handlePublicDiscovery(rpc('tools/list'));
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      result: { tools: Array<{ name: string; description?: string; inputSchema: unknown }> };
    };
    expect(body.result.tools.length).toBeGreaterThan(10);
    for (const tool of body.result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('leaves tools/call to the authenticated transport', async () => {
    expect(await handlePublicDiscovery(rpc('tools/call', { name: 'beel_docs_search' }))).toBeNull();
  });
});

describe('advertised scopes', () => {
  it('are the scopes the tools need plus sandbox, sorted and unique', () => {
    const scopes = advertisedScopes();
    expect(scopes).toContain(SANDBOX_SCOPE);
    expect(scopes).toContain('invoices:write');
    expect(scopes).toEqual([...new Set(scopes)].sort());
    const declared = specScopes();
    for (const scope of scopes) {
      if (scope !== SANDBOX_SCOPE) expect(declared.has(scope)).toBe(true);
    }
  });
});

describe('public resources', () => {
  it('reads the guardrail index and the viewer without a token', async () => {
    const index = await handlePublicDiscovery(rpc('resources/read', { uri: 'beel://guardrails' }));
    expect(index?.status).toBe(200);
    const indexBody = (await index!.json()) as {
      result: { contents: Array<{ mimeType: string; text: string }> };
    };
    expect(indexBody.result.contents[0]?.mimeType).toBe('text/markdown');
    expect(indexBody.result.contents[0]?.text).toContain('# BeeL fiscal guardrails');

    const app = await handlePublicDiscovery(rpc('resources/read', { uri: INVOICE_PDF_APP_URI }));
    expect(app?.status).toBe(200);
    const appBody = (await app!.json()) as {
      result: { contents: Array<{ mimeType: string; text: string; _meta: unknown }> };
    };
    const [content] = appBody.result.contents;
    expect(content?.mimeType).toBe(MCP_APP_MIME);
    expect(content?.text.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(content?.text).toContain('http-equiv="Content-Security-Policy"');
    expect(content?.text).not.toMatch(/type="password"/);
    expect(content?._meta).toBeTruthy();
  });

  it('every listed resource reads cleanly', async () => {
    const list = await handlePublicDiscovery(rpc('resources/list'));
    const { result } = (await list!.json()) as { result: { resources: Array<{ uri: string }> } };
    expect(result.resources.length).toBeGreaterThan(5);
    for (const { uri } of result.resources) {
      const read = await handlePublicDiscovery(rpc('resources/read', { uri }));
      const body = (await read!.json()) as {
        result?: { contents: Array<{ mimeType?: string; text?: string }> };
        error?: unknown;
      };
      expect(body.error, uri).toBeUndefined();
      expect(body.result?.contents[0]?.mimeType, uri).toBeTruthy();
      expect(body.result?.contents[0]?.text?.length ?? 0, uri).toBeGreaterThan(0);
    }
  });
});

describe('viewer CSP meta', () => {
  it('scopes connect, frame-ancestors, form-action and resource origins', () => {
    const csp = appCspMeta(appCsp({ MCP_PUBLIC_URL: 'https://mcp.example.com' }));
    expect(csp).toContain('connect-src https://mcp.example.com https://cdnjs.cloudflare.com');
    expect(csp).toContain('frame-ancestors https://claude.ai https://chatgpt.com');
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("script-src 'unsafe-inline' https://cdnjs.cloudflare.com");
    expect(csp).not.toContain('*');
    const html = withCspMeta(
      '<!DOCTYPE html><html><head><title>x</title></head></html>',
      appCsp({}),
    );
    expect(html).toMatch(/<head>\n<meta http-equiv="Content-Security-Policy"/);
    expect(withCspMeta(html, appCsp({}))).toBe(html);
  });
});
