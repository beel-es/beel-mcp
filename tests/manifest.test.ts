import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';
import { API_KEY_SECURITY_SCHEME, BEEL_HEADER } from '../src/shared/defaults.js';

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

  it('surfaces no required header the tool schema cannot supply', () => {
    // Header parameters are set by the http layer, not by the model: they are
    // absent from every inputSchema. A REQUIRED one the layer does not know
    // about would therefore be missing from every call, and the API would
    // reject each of them for a reason nothing in this repo could explain.
    // Idempotency-Key is the one exception, and it is supplied for every POST.
    const unsupplied = manifest.flatMap((op) =>
      op.headerParams
        .filter((h) => h.required && h.name !== BEEL_HEADER.idempotencyKey)
        .map((h) => `${op.operationId}: ${h.name}`),
    );
    expect(unsupplied).toEqual([]);
  });

  it('keeps every tag an operation declares', () => {
    // Guardrails bind by tag, and an operation carrying two is guarded by both
    // or by neither. Keeping only the first silently drops the second binding.
    for (const op of manifest) expect(op.tags.length).toBeGreaterThan(0);
    expect(byId('createCompanyInvoice').tags).toContain('CompanyInvoices');
  });

  it('reads the security schemes an operation accepts, inheriting the document default', () => {
    expect(byId('createCompanyInvoice').securitySchemes).toContain(API_KEY_SECURITY_SCHEME);
    expect(byId('putAccountOwner').securitySchemes).not.toContain(API_KEY_SECURITY_SCHEME);
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
