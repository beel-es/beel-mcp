import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichToolResult } from '../src/tools/tool-result.js';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

function stubFetch(map: Record<string, { body: Uint8Array; type: string; status?: number }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const hit = map[url];
      if (!hit) return new Response('not found', { status: 404 });
      return new Response(hit.body as unknown as BodyInit, {
        status: hit.status ?? 200,
        headers: { 'content-type': hit.type },
      });
    }),
  );
}

describe('enrichToolResult', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null for operations without an enricher', async () => {
    expect(await enrichToolResult('listCompanyInvoices', { items: [] })).toBeNull();
  });

  it('shapes the PDF result: structuredContent for the viewer + PDF attachment', async () => {
    stubFetch({ 'https://files.example.test/x.pdf': { body: PDF_BYTES, type: 'application/pdf' } });
    const result = await enrichToolResult('getCompanyInvoicePdf', {
      download_url: 'https://files.example.test/x.pdf',
      file_name: 'factura_A-2026-0041.pdf',
    });
    // structuredContent alimenta el visor (MCP App).
    expect(result?.structuredContent).toEqual({
      download_url: 'https://files.example.test/x.pdf',
      file_name: 'factura_A-2026-0041.pdf',
    });
    // PDF real adjunto.
    const resource = result?.content.find((c) => c.type === 'resource') as any;
    expect(resource?.resource.mimeType).toBe('application/pdf');
    expect(resource?.resource.blob).toBe(btoa('%PDF'));
    expect(result?.content.some((c) => c.type === 'text')).toBe(true);
  });

  it('still returns viewer data when the PDF attachment download fails', async () => {
    stubFetch({ 'https://files.example.test/x.pdf': { body: PDF_BYTES, type: 'application/pdf', status: 403 } });
    const result = await enrichToolResult('getCompanyInvoicePdf', {
      download_url: 'https://files.example.test/x.pdf',
    });
    // El visor puede seguir (tiene la URL); solo falta el adjunto.
    expect(result?.structuredContent).toMatchObject({ download_url: 'https://files.example.test/x.pdf' });
    expect(result?.content.some((c) => c.type === 'resource')).toBe(false);
  });

  it('falls back to null when the payload has no download_url', async () => {
    expect(await enrichToolResult('getCompanyInvoicePdf', { foo: 1 })).toBeNull();
  });
});
