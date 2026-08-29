import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { SETUP_STATUS, workflowTools } from '../src/tools/workflow-tools.js';
import { DOCS_SEARCH } from '../src/tools/docs-tools.js';
import type { ResolvedConfig } from '../src/config.js';

const config: ResolvedConfig = {
  apiKey: 'beel_sk_test_x',
  env: 'test',
  baseUrl: 'https://api.test',
  transport: 'stdio',
};

/**
 * Reach the CallTool handler the way a client does, without a transport: the
 * SDK exposes the registered handlers, and dispatch is what these cases are about.
 */
function callTool(name: string, args?: unknown): Promise<CallToolResult> {
  const server = createServer(
    { name: 'test', version: '0' },
    { quiet: true, getConfig: () => config },
  );
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<CallToolResult>>;
    }
  )._requestHandlers;
  const handler = handlers.get(CallToolRequestSchema.shape.method.value)!;
  return handler({ method: 'tools/call', params: { name, arguments: args } }, {});
}

const textOf = (result: CallToolResult): string =>
  result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

afterEach(() => vi.unstubAllGlobals());

describe('CallTool dispatch', () => {
  it('answers an unknown tool as an error rather than throwing', async () => {
    const result = await callTool('beel_does_not_exist');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool');
  });

  it('never lets arguments that are not a JSON object reach a tool', async () => {
    // The protocol layer refuses most of these on its own; the handler's own
    // guard covers the case where it does not, so an array never sails through
    // a cast to fail later as a missing property.
    for (const bad of [['a'], 'a', 3]) {
      let outcome: CallToolResult | Error;
      try {
        outcome = await callTool('beel_list_companies', bad);
      } catch (err) {
        outcome = err as Error;
      }
      if (outcome instanceof Error) continue;
      expect(outcome.isError).toBe(true);
      expect(textOf(outcome)).toContain('arguments must be a JSON object');
    }
  });

  it('turns an invalid argument into an error naming the field', async () => {
    const result = await callTool('beel_create_invoice', { company_id: 123 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('company_id');
  });

  it('validates the arguments of a docs tool too', async () => {
    const result = await callTool(DOCS_SEARCH, { terms: 'not-an-array' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('terms');
  });

  it('validates the arguments of a workflow tool too', async () => {
    const result = await callTool(SETUP_STATUS, { company_id: 42 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('company_id');
  });

  it('returns the workflow tool structuredContent, validated against its outputSchema', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }),
    );
    const result = await callTool(SETUP_STATUS, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ environment: 'test' });
  });

  it('reports an upstream API error through the guardrail catalogue', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'INVOICE_NO_LINES', message: 'sin líneas' },
          }),
          { status: 422 },
        ),
    );
    const result = await callTool('beel_list_companies', {
      account_id: '9c8f1f2e-2b7a-4a1e-9d1f-3f5a8c2b7e10',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('INVOICE_NO_LINES');
  });

  it('logs one structured line per call, with no arguments in it', async () => {
    const lines: string[] = [];
    vi.stubGlobal('console', { ...console, error: (line: string) => lines.push(line) });
    await callTool('beel_create_invoice', { company_id: 'secret-company-id' });
    const entry = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      evt: 'tool_call',
      tool: 'beel_create_invoice',
      outcome: 'error',
    });
    expect(typeof entry.ms).toBe('number');
    expect(lines.join(' ')).not.toContain('secret-company-id');
  });
});

describe('hand-written tool names', () => {
  const derived = new Set(buildApiTools().tools.map((t) => t.tool.name));
  const synthetic = [
    ...workflowTools.map((t) => t.name),
    DOCS_SEARCH,
    'beel_docs_get',
    'beel_docs_list',
  ];

  it('follow the beel_ convention', () => {
    for (const name of synthetic) expect(name).toMatch(/^beel_[a-z0-9_]+$/);
  });

  it('collide with no name derived from the contract', () => {
    // A collision would shadow a real operation silently: the synthetic handler
    // runs first, and the API tool becomes unreachable.
    expect(synthetic.filter((name) => derived.has(name))).toEqual([]);
  });
});
