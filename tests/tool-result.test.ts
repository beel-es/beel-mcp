import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichToolResult } from '../src/tools/tool-result.js';

describe('enrichToolResult', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null for operations without an enricher', async () => {
    expect(await enrichToolResult('listCompanyInvoices', { items: [] })).toBeNull();
  });

  it('embeds the invoice PDF as an application/pdf resource', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(pdf, { status: 200 })),
    );

    const result = await enrichToolResult('getCompanyInvoicePdf', {
      download_url: 'https://storage.beel.es/x.pdf',
      file_name: 'factura_A-2026-0041.pdf',
    });

    const resource = result?.content.find((c) => c.type === 'resource');
    expect((resource as any)?.resource.mimeType).toBe('application/pdf');
    expect((resource as any)?.resource.uri).toContain('factura_A-2026-0041.pdf');
    expect((resource as any)?.resource.blob).toBe(btoa('%PDF'));
  });

  it('falls back to null when the payload has no download_url', async () => {
    expect(await enrichToolResult('getCompanyInvoicePdf', { foo: 1 })).toBeNull();
  });

  it('falls back to null when the download fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    const result = await enrichToolResult('getCompanyInvoicePdf', {
      download_url: 'https://storage.beel.es/x.pdf',
    });
    expect(result).toBeNull();
  });
});
