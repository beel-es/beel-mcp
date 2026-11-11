import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BeelClient, ToolError, type ToolCaller } from '../src/mcpapp/beel-app/client.js';
import { Controller, type HostPort } from '../src/mcpapp/beel-app/controller.js';
import { createAppToolHandler } from '../src/mcpapp/beel-app/app-tools.js';
import { INITIAL_STATE, type AppState } from '../src/mcpapp/beel-app/model.js';
import { Store } from '../src/mcpapp/beel-app/store.js';
import { BEEL_APP_CALLS, BEEL_APP_SETUP_TOOL } from '../src/mcpapp/contract.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { SETUP_STATUS } from '../src/tools/workflow-tools.js';
import { toolName } from '../src/spec/derive.js';
import { apiToolsFor } from '../src/policy/surface.js';

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const refusal = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const SETUP = {
  environment: 'live',
  companies: [
    { company_id: 'c1', legal_name: 'Honey Solutions S.L.', ready: true },
    { company_id: 'c2', legal_name: 'Second S.L.', ready: false, blockers: ['No default series'] },
  ],
};
const DRAFT = { id: 'i1', status: 'DRAFT', recipient: { email: 'a@acme.test' } };

/** A fake server: answers by tool name and records every call. */
function fakeServer(
  overrides: Record<string, (args: Record<string, unknown>) => CallToolResult> = {},
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const routes: Record<string, (args: Record<string, unknown>) => CallToolResult> = {
    [BEEL_APP_SETUP_TOOL]: () => json(SETUP),
    [toolName(BEEL_APP_CALLS.fiscalSummary)]: () => json({ total_vat: 210 }),
    [toolName(BEEL_APP_CALLS.listInvoices)]: () =>
      json({ invoices: [DRAFT], pagination: { total_items: 1 } }),
    [toolName(BEEL_APP_CALLS.getInvoice)]: () => json(DRAFT),
    [toolName(BEEL_APP_CALLS.issueInvoice)]: () =>
      json({ ...DRAFT, status: 'ISSUED', invoice_number: 'F-2026-0043' }),
    [toolName(BEEL_APP_CALLS.listCustomers)]: () => json({ customers: [] }),
    ...overrides,
  };
  const caller: ToolCaller = async (name, args) => {
    calls.push({ name, args });
    const route = routes[name];
    return route ? route(args) : refusal(`Unknown tool: ${name}`);
  };
  return { caller, calls };
}

function fakeHost(overrides: Partial<HostPort> = {}): HostPort {
  return {
    sendMessage: vi.fn(async () => true),
    updateModelContext: vi.fn(async () => undefined),
    canDownload: () => true,
    download: vi.fn(async () => true),
    openLink: vi.fn(async () => undefined),
    fetchBytes: vi.fn(async () => new ArrayBuffer(4)),
    ...overrides,
  };
}

function setup(server = fakeServer(), host = fakeHost()) {
  const store = new Store<AppState>(INITIAL_STATE);
  const ctl = new Controller(
    store,
    new BeelClient(server.caller, () => 'key-1'),
    host,
    () => new Date(2026, 10, 11),
  );
  return { store, ctl, host, calls: server.calls };
}

describe('the tools the app calls', () => {
  it('are all exposed on the full surface, by their derived names', () => {
    const exposed = new Set(apiToolsFor(buildApiTools().tools, 'full').map((t) => t.tool.name));
    for (const operationId of Object.values(BEEL_APP_CALLS)) {
      expect(exposed, operationId).toContain(toolName(operationId));
    }
    expect(BEEL_APP_SETUP_TOOL).toBe(SETUP_STATUS);
  });
});

describe('BeelClient', () => {
  it('turns a refused call into a ToolError carrying the server explanation', async () => {
    const client = new BeelClient(async () => refusal('EMISSION_NOT_READY: no series'));
    await expect(client.setup()).rejects.toThrow(new ToolError('EMISSION_NOT_READY: no series'));
  });

  it('sends a fresh Idempotency-Key with every write', async () => {
    const server = fakeServer();
    const client = new BeelClient(server.caller, () => 'key-42');
    await client.issue('c1', 'i1');
    expect(server.calls[0]!.args).toEqual({
      company_id: 'c1',
      invoice_id: 'i1',
      idempotency_key: 'key-42',
    });
  });

  it('takes the PDF link from structured content and the file when attached', async () => {
    const client = new BeelClient(async () => ({
      content: [
        {
          type: 'resource',
          resource: { uri: 'beel://x.pdf', mimeType: 'application/pdf', blob: 'JVBERg==' },
        },
        { type: 'text', text: 'Invoice x.pdf' },
      ],
      structuredContent: { download_url: 'https://files.test/x.pdf', file_name: 'x.pdf' },
    }));
    expect(await client.pdf('c1', 'i1')).toEqual({
      download_url: 'https://files.test/x.pdf',
      file_name: 'x.pdf',
      base64: 'JVBERg==',
    });
  });
});

describe('Controller', () => {
  it('opens on the company the tool call named, and loads the quarter to date', async () => {
    const { store, ctl, calls, host } = setup();
    ctl.preferCompany('c2');
    await ctl.navigate({ view: 'home' });
    expect(store.get()).toMatchObject({
      phase: 'ready',
      companyId: 'c2',
      summary: { total_vat: 210 },
    });
    const summaryCall = calls.find((c) => c.name === toolName(BEEL_APP_CALLS.fiscalSummary));
    expect(summaryCall?.args).toEqual({
      company_id: 'c2',
      start_date: '2026-10-01',
      end_date: '2026-11-11',
    });
    expect(host.updateModelContext).toHaveBeenCalledOnce();
  });

  it('drops the answer of a view the user already left', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const server = fakeServer({
      [toolName(BEEL_APP_CALLS.getInvoice)]: () => json(DRAFT),
    });
    const caller: ToolCaller = async (name, args) => {
      if (name === toolName(BEEL_APP_CALLS.listCustomers)) await slow;
      return server.caller(name, args);
    };
    const { store, ctl } = setup({ caller, calls: server.calls });
    const leaving = ctl.navigate({ view: 'customers' });
    await ctl.navigate({ view: 'invoice', invoice_id: 'i1' });
    release();
    await leaving;
    expect(store.get().view).toBe('invoice');
    expect(store.get().invoice?.id).toBe('i1');
  });

  it('issues only after the confirmation, and says it reached the AEAT in Live', async () => {
    const { store, ctl, calls } = setup();
    await ctl.navigate({ view: 'invoice', invoice_id: 'i1' });
    ctl.requestIssue();
    expect(store.get().confirmingIssue).toBe(true);
    await ctl.issue();
    expect(calls.some((c) => c.name === toolName(BEEL_APP_CALLS.issueInvoice))).toBe(true);
    expect(store.get()).toMatchObject({
      confirmingIssue: false,
      pending: undefined,
      invoice: { status: 'ISSUED' },
      feedback: { tone: 'ok', title: 'Factura F-2026-0043 emitida. La AEAT la está procesando.' },
    });
  });

  it('shows a refusal under its own headline, with the server explanation as detail', async () => {
    const { store, ctl } = setup(
      fakeServer({ [toolName(BEEL_APP_CALLS.issueInvoice)]: () => refusal('NIF not in census') }),
    );
    await ctl.navigate({ view: 'invoice', invoice_id: 'i1' });
    await ctl.issue();
    expect(store.get().feedback).toEqual({
      tone: 'error',
      title: 'No se ha podido emitir la factura.',
      detail: 'NIF not in census',
    });
  });

  it('acts on nothing once a newer panel took over', async () => {
    const { store, ctl, calls, host } = setup();
    await ctl.navigate({ view: 'invoice', invoice_id: 'i1' });
    ctl.markSuperseded();
    const before = calls.length;
    await ctl.issue();
    await ctl.askClaude('hola');
    expect(calls.length).toBe(before);
    expect(host.sendMessage).not.toHaveBeenCalled();
    expect(store.get().superseded).toBe(true);
  });

  it('tells the user when Claude did not take the message', async () => {
    const { store, ctl } = setup(fakeServer(), fakeHost({ sendMessage: async () => false }));
    await ctl.askClaude('Quiero crear una factura nueva.');
    expect(store.get().feedback?.tone).toBe('error');
  });

  it('exports the list shown as a CSV download', async () => {
    const { ctl, host } = setup();
    await ctl.navigate({ view: 'invoices', filter: 'all' });
    await ctl.exportCsv();
    expect(host.download).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'facturas-2026-11-11.csv', mimeType: 'text/csv' }),
    );
  });
});

describe('app tools', () => {
  it('validate their arguments and answer with what is now on screen', async () => {
    const { store, ctl } = setup();
    const call = createAppToolHandler(ctl, store);
    const bad = await call('show_view', { view: 'invoice' });
    expect(bad.isError).toBe(true);

    const shown = await call('show_view', { view: 'invoices', status: ['DRAFT'] });
    expect(shown.isError).toBe(false);
    const state = JSON.parse((shown.content[0] as { text: string }).text);
    expect(state).toMatchObject({ view: 'invoices', filter: 'drafts', company_id: 'c1' });
    expect(state.invoices[0]).toMatchObject({ invoice_id: 'i1' });

    expect((await call('nope', {})).isError).toBe(true);
  });
});
