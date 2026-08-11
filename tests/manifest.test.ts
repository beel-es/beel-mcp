import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';

const manifest = buildManifest(loadSpec());
const byId = (id: string): OperationSpec => {
  const op = manifest.find((o) => o.operationId === id);
  if (!op) throw new Error(`operation ${id} not found in manifest`);
  return op;
};

describe('buildManifest', () => {
  it('discovers a healthy number of operations', () => {
    expect(manifest.length).toBeGreaterThan(60);
  });

  it('captures method, path and tag', () => {
    const op = byId('createInvoice');
    expect(op.method).toBe('POST');
    expect(op.path).toBe('/v1/invoices');
    expect(op.requestBody?.contentType).toContain('json');
    expect(op.requestBody?.required).toBe(true);
  });

  it('captures the deprecated flag from the spec', () => {
    expect(byId('listInvoices').deprecated).toBe(true);
    expect(byId('listCompanyInvoices').deprecated).toBe(false);
  });

  it('resolves $ref-ed shared query parameters', () => {
    const names = byId('listInvoices').queryParams.map((p) => p.name);
    expect(names).toContain('page');
    expect(names).toContain('limit');
  });

  it('extracts path parameters', () => {
    expect(byId('getInvoice').pathParams.map((p) => p.name)).toEqual(['invoice_id']);
  });

  it('flags binary responses', () => {
    expect(byId('exportInvoicesExcel').binaryResponse).toBe(true);
    expect(byId('previewDraftInvoicePdf').binaryResponse).toBe(true);
    expect(byId('listInvoices').binaryResponse).toBe(false);
  });

  it('flags multipart request bodies', () => {
    expect(byId('importCustomersCsvPreview').requestBody?.contentType).toContain('multipart');
  });
});
