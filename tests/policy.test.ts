import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { applyToolPolicy } from '../src/policy/tool-policy.js';
import { requiredScopes } from '../src/policy/scopes.js';
import { DESTRUCTIVE_OPERATION_IDS } from '../src/policy/annotations.js';

const manifest = buildManifest(loadSpec());
const { tools, excluded } = applyToolPolicy(manifest);

const includedIds = new Set(tools.map((t) => t.operationId));
const reasonFor = (id: string) => excluded.find((e) => e.op.operationId === id)?.reason;

describe('tool policy', () => {
  it('includes the core company-scoped invoicing operations', () => {
    for (const id of ['createCompanyInvoice', 'listCompanyInvoices', 'voidCompanyInvoice', 'validateNif']) {
      expect(includedIds.has(id)).toBe(true);
    }
  });

  it('excludes deprecated legacy operations superseded by the company-scoped API', () => {
    for (const id of ['createInvoice', 'listInvoices', 'voidInvoice', 'issueInvoice']) {
      expect(reasonFor(id)).toBe('deprecated');
    }
  });

  it('excludes webhook infrastructure', () => {
    expect(reasonFor('createWebhookSubscription')).toBe('webhook-infrastructure');
    expect(reasonFor('listWebhookDeliveries')).toBe('webhook-infrastructure');
  });

  it('excludes binary downloads', () => {
    expect(reasonFor('createCompanyInvoiceExport')).toBe('binary-response');
    expect(reasonFor('previewCompanyInvoicePdf')).toBe('binary-response');
  });

  it('excludes multipart uploads', () => {
    expect(reasonFor('createCompanyCustomerImport')).toBe('multipart-upload');
    expect(reasonFor('submitCompanyRepresentation')).toBe('multipart-upload');
  });

  it('every operation is either included or excluded, never both', () => {
    expect(tools.length + excluded.length).toBe(manifest.length);
    for (const e of excluded) expect(includedIds.has(e.op.operationId)).toBe(false);
  });

  it('requiredScopes is the union of scopes across exposed tools, least-privilege', () => {
    const scopes = requiredScopes(manifest);
    // Resources the MCP genuinely operates on must be requestable...
    for (const s of ['invoices:read', 'invoices:write', 'products:read', 'companies:list', 'nif:validate']) {
      expect(scopes).toContain(s);
    }
    // ...and it must not invent scopes no exposed tool declares.
    const declared = new Set(tools.flatMap((t) => t.scopes));
    for (const s of scopes) expect(declared.has(s)).toBe(true);
  });

  it('honours explicit include overrides', () => {
    const forced = applyToolPolicy(manifest, {
      includedOperationIds: new Set(['exportInvoicesExcel']),
    });
    expect(forced.tools.some((t) => t.operationId === 'exportInvoicesExcel')).toBe(true);
  });
});

describe('annotation lists stay anchored to the spec', () => {
  it('every hardcoded destructive operationId still exists as a tool', () => {
    // These lists are curated by hand and were broken repeatedly by API
    // migrations renaming operationIds. Failing here beats shipping an
    // annotation that silently stops applying to anything.
    const known = new Set(tools.map((op) => op.operationId));
    const stale = [...DESTRUCTIVE_OPERATION_IDS].filter((id) => !known.has(id));
    expect(stale).toEqual([]);
  });
});
