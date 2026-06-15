import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { applyToolPolicy } from '../src/policy/tool-policy.js';

const manifest = buildManifest(loadSpec());
const { tools, excluded } = applyToolPolicy(manifest);

const includedIds = new Set(tools.map((t) => t.operationId));
const reasonFor = (id: string) => excluded.find((e) => e.op.operationId === id)?.reason;

describe('tool policy', () => {
  it('includes the core invoicing operations', () => {
    for (const id of ['createInvoice', 'listInvoices', 'voidInvoice', 'createCorrectiveInvoice', 'validateNif']) {
      expect(includedIds.has(id)).toBe(true);
    }
  });

  it('excludes webhook infrastructure', () => {
    expect(reasonFor('createWebhookSubscription')).toBe('webhook-infrastructure');
    expect(reasonFor('listWebhookDeliveries')).toBe('webhook-infrastructure');
  });

  it('excludes binary downloads', () => {
    expect(reasonFor('exportInvoicesExcel')).toBe('binary-response');
    expect(reasonFor('downloadInvoicesPdfBulk')).toBe('binary-response');
    expect(reasonFor('previewDraftInvoicePdf')).toBe('binary-response');
  });

  it('excludes multipart uploads', () => {
    expect(reasonFor('importCustomersCsvPreview')).toBe('multipart-upload');
    expect(reasonFor('submitRepresentation')).toBe('multipart-upload');
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
