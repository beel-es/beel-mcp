import { describe, expect, it } from 'vitest';
import { buildApiTools } from '../src/tools/api-tools.js';
import { pdfAppResource } from '../src/resources/pdf-app.js';
import {
  INVOICE_PDF_APP_URI,
  MCP_APP_MIME,
  pdfConnectDomains,
  pdfStorageHosts,
} from '../src/ui/registry.js';

describe('MCP Apps PDF viewer', () => {
  const { tools } = buildApiTools();
  const toolByName = (name: string) => tools.find((t) => t.tool.name === name);

  it('links beel_get_company_invoice_pdf to the PDF viewer resource', () => {
    const pdf = toolByName('beel_get_company_invoice_pdf');
    expect(pdf?.appResourceUri).toBe(INVOICE_PDF_APP_URI);
    expect((pdf?.tool._meta as any)?.ui?.resourceUri).toBe(INVOICE_PDF_APP_URI);
  });

  it('does not attach a UI panel to ordinary tools', () => {
    const list = toolByName('beel_list_company_invoices');
    expect(list?.appResourceUri).toBeUndefined();
    expect((list?.tool._meta as any)?.ui).toBeUndefined();
  });

  it('exposes the app resource with the MCP Apps mime type', () => {
    expect(pdfAppResource.uri).toBe(INVOICE_PDF_APP_URI);
    expect(pdfAppResource.mimeType).toBe(MCP_APP_MIME);
    expect(MCP_APP_MIME).toBe('text/html;profile=mcp-app');
  });

  it('derives CSP connect domains with a sane default and env override', () => {
    expect(pdfConnectDomains({} as NodeJS.ProcessEnv)).toEqual(['https://mcp.beel.es']);
    const overridden = pdfConnectDomains({
      BEEL_PDF_CONNECT_ORIGIN: 'https://a.test',
    } as NodeJS.ProcessEnv);
    expect(overridden).toEqual(['https://a.test']);
  });

  it('guards the proxy allowlist (default hosts + env override)', () => {
    expect(pdfStorageHosts({} as NodeJS.ProcessEnv).has('storage.beel.es')).toBe(true);
    const overridden = pdfStorageHosts({
      BEEL_PDF_STORAGE_HOSTS: 'only.test',
    } as NodeJS.ProcessEnv);
    expect(overridden.has('only.test')).toBe(true);
    expect(overridden.has('storage.beel.es')).toBe(false);
  });
});
