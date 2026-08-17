/**
 * Recurso ui:// del visor de factura: sirve el HTML (con la app inline; pdf.js
 * NO va inline, se carga de cdnjs en runtime) y su CSP. El HTML lo genera
 * scripts/build-mcpapp.mjs. En el worker CF se inyecta como módulo Text
 * (setInvoicePdfAppHtml); en Node se lee de disco (dist/mcpapp).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import { APP_CSP, INVOICE_PDF_APP_URI, MCP_APP_MIME } from './contract.js';

export const invoicePdfAppResource: Resource = {
  uri: INVOICE_PDF_APP_URI,
  name: 'Visor de factura (PDF)',
  description:
    'Panel interactivo que renderiza el PDF de la factura. Lo abre el host al ' +
    'llamar a beel_get_company_invoice_pdf.',
  mimeType: MCP_APP_MIME,
};

let injectedHtml: string | null = null;

/** Inyecta el HTML construido (el bundle del worker lo importa como Text module). */
export function setInvoicePdfAppHtml(html: string): void {
  injectedHtml = html;
}

const HTML_CANDIDATES = [
  './mcpapp/invoice-pdf.html', // desde dist/index.js
  '../../dist/mcpapp/invoice-pdf.html', // desde src/mcpapp/*.ts (tsx dev)
];

function resolveHtmlFromDisk(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of HTML_CANDIDATES) {
    const path = resolve(here, candidate);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return null;
}

/** HTML + CSP del visor; `null` si el bundle no se ha construido. */
export function readInvoicePdfApp(): { html: string; csp: typeof APP_CSP } | null {
  const html = injectedHtml ?? resolveHtmlFromDisk();
  return html ? { html, csp: APP_CSP } : null;
}
