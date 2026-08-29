import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichToolResult } from '../src/tools/tool-result.js';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
const DOWNLOAD_URL = 'https://files.example.test/x.pdf';

function stubFetch(map: Record<string, { body: Uint8Array; type: string; status?: number }>) {
  const fetchMock = vi.fn(async (url: URL | string) => {
    const hit = map[String(url)];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body as unknown as BodyInit, {
      status: hit.status ?? 200,
      headers: { 'content-type': hit.type },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The relay's storage allow-list is deployment configuration, never a literal. */
function allowStorageHost(host = 'files.example.test') {
  vi.stubEnv('BEEL_PDF_STORAGE_HOSTS', host);
}

describe('enrichToolResult', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns null for operations without an enricher', async () => {
    expect(await enrichToolResult('listCompanyInvoices', { items: [] })).toBeNull();
  });

  it('shapes the PDF result: structuredContent for the viewer plus a PDF attachment', async () => {
    allowStorageHost();
    stubFetch({ [DOWNLOAD_URL]: { body: PDF_BYTES, type: 'application/pdf' } });
    const result = await enrichToolResult('getCompanyInvoicePdf', {
      download_url: DOWNLOAD_URL,
      file_name: 'factura_A-2026-0041.pdf',
    });
    // structuredContent is what feeds the MCP App viewer.
    expect(result?.structuredContent).toEqual({
      download_url: DOWNLOAD_URL,
      file_name: 'factura_A-2026-0041.pdf',
    });
    const resource = result?.content.find((c) => c.type === 'resource') as
      { resource: { mimeType: string; blob: string } } | undefined;
    expect(resource?.resource.mimeType).toBe('application/pdf');
    expect(resource?.resource.blob).toBe(btoa('%PDF'));
    expect(result?.content.some((c) => c.type === 'text')).toBe(true);
  });

  it('keeps the viewer data and says why when the download fails', async () => {
    allowStorageHost();
    stubFetch({ [DOWNLOAD_URL]: { body: PDF_BYTES, type: 'application/pdf', status: 403 } });
    const result = await enrichToolResult('getCompanyInvoicePdf', { download_url: DOWNLOAD_URL });
    // The viewer still has the URL; only the inline copy is missing, and the
    // text says so rather than leaving the absence unexplained.
    expect(result?.structuredContent).toMatchObject({ download_url: DOWNLOAD_URL });
    expect(result?.content.some((c) => c.type === 'resource')).toBe(false);
    expect((result?.content[0] as { text: string }).text).toContain('HTTP 403');
  });

  it('falls back to null when the payload has no download_url', async () => {
    expect(await enrichToolResult('getCompanyInvoicePdf', { foo: 1 })).toBeNull();
  });
});

describe('the attachment is fetched only from an allow-listed storage host', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('fetches nothing when no host is configured', async () => {
    const fetchMock = stubFetch({ [DOWNLOAD_URL]: { body: PDF_BYTES, type: 'application/pdf' } });
    const result = await enrichToolResult('getCompanyInvoicePdf', { download_url: DOWNLOAD_URL });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((result?.content[0] as { text: string }).text).toContain('BEEL_PDF_STORAGE_HOSTS');
    expect(result?.structuredContent).toMatchObject({ download_url: DOWNLOAD_URL });
  });

  it('refuses a host the payload names but the deployment did not', async () => {
    allowStorageHost('files.example.test');
    const fetchMock = stubFetch({});
    const result = await enrichToolResult('getCompanyInvoicePdf', {
      download_url: 'https://attacker.test/x.pdf',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((result?.content[0] as { text: string }).text).toContain('attacker.test');
  });

  it('refuses plaintext http even on an allow-listed host', async () => {
    allowStorageHost();
    const fetchMock = stubFetch({});
    await enrichToolResult('getCompanyInvoicePdf', {
      download_url: 'http://files.example.test/x.pdf',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
