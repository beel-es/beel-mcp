import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { applyToolPolicy } from '../src/policy/tool-policy.js';

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

  it('honours explicit include overrides', () => {
    const forced = applyToolPolicy(manifest, {
      includedOperationIds: new Set(['exportInvoicesExcel']),
    });
    expect(forced.tools.some((t) => t.operationId === 'exportInvoicesExcel')).toBe(true);
  });
});
