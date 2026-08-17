import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichToolResult, type EnricherContext } from '../src/tools/tool-result.js';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF

function stubFetch(map: Record<string, { body: Uint8Array; type: string; status?: number }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const hit = map[url];
      if (!hit) return new Response('not found', { status: 404 });
      return new Response(hit.body, {
        status: hit.status ?? 200,
        headers: { 'content-type': hit.type },
      });
    }),
  );
}

/** ctx con args de company/invoice y un callOperation configurable (para /preview). */
function ctx(overrides: Partial<EnricherContext> = {}): EnricherContext {
  return {
    args: { company_id: 'c1', invoice_id: 'i1' },
    callOperation: async () => ({ image_url: 'https://storage.beel.es/x.webp' }),
    ...overrides,
  };
}

describe('enrichToolResult', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null for operations without an enricher', async () => {
    expect(await enrichToolResult('listCompanyInvoices', { items: [] }, ctx())).toBeNull();
  });

  it('embeds the preview image (from /preview) plus the PDF resource', async () => {
    stubFetch({
      'https://storage.beel.es/x.pdf': { body: PDF_BYTES, type: 'application/pdf' },
      'https://storage.beel.es/x.webp': { body: WEBP_BYTES, type: 'image/webp' },
    });
    const result = await enrichToolResult(
      'getCompanyInvoicePdf',
      { download_url: 'https://storage.beel.es/x.pdf', file_name: 'factura_A-2026-0041.pdf' },
      ctx(),
    );
    const image = result?.content.find((c) => c.type === 'image') as any;
    expect(image?.mimeType).toBe('image/webp');
    expect(image?.data).toBe(btoa('RIFF'));
    const resource = result?.content.find((c) => c.type === 'resource') as any;
    expect(resource?.resource.mimeType).toBe('application/pdf');
    expect(resource?.resource.blob).toBe(btoa('%PDF'));
  });

  it('still returns the PDF when the preview endpoint fails', async () => {
    stubFetch({ 'https://storage.beel.es/x.pdf': { body: PDF_BYTES, type: 'application/pdf' } });
    const result = await enrichToolResult(
      'getCompanyInvoicePdf',
      { download_url: 'https://storage.beel.es/x.pdf' },
      ctx({ callOperation: async () => { throw new Error('boom'); } }),
    );
    expect(result?.content.some((c) => c.type === 'image')).toBe(false);
    expect(result?.content.some((c) => c.type === 'resource')).toBe(true);
  });

  it('still returns the PDF when the preview image download fails', async () => {
    // /preview devuelve una URL, pero la descarga de la imagen falla (404).
    stubFetch({ 'https://storage.beel.es/x.pdf': { body: PDF_BYTES, type: 'application/pdf' } });
    const result = await enrichToolResult(
      'getCompanyInvoicePdf',
      { download_url: 'https://storage.beel.es/x.pdf' },
      ctx({ callOperation: async () => ({ image_url: 'https://storage.beel.es/missing.webp' }) }),
    );
    expect(result?.content.some((c) => c.type === 'image')).toBe(false);
    expect(result?.content.some((c) => c.type === 'resource')).toBe(true);
  });

  it('falls back to null when the payload has no download_url', async () => {
    expect(await enrichToolResult('getCompanyInvoicePdf', { foo: 1 }, ctx())).toBeNull();
  });

  it('falls back to null when the PDF download fails', async () => {
    stubFetch({ 'https://storage.beel.es/x.pdf': { body: PDF_BYTES, type: 'application/pdf', status: 403 } });
    const result = await enrichToolResult(
      'getCompanyInvoicePdf',
      { download_url: 'https://storage.beel.es/x.pdf' },
      ctx(),
    );
    expect(result).toBeNull();
  });
});
