import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import { INVOICE_PDF_APP_URI, MCP_APP_MIME, pdfFrameDomains } from '../ui/registry.js';

/**
 * Serves the invoice-PDF MCP App resource. The HTML is built by
 * scripts/build-ui.mjs into dist/ui/invoice-pdf.html; we probe candidate paths
 * so it resolves from both the published bundle and tsx dev.
 */
const HTML_CANDIDATES = [
  './ui/invoice-pdf.html', // from dist/index.js or dist/chunk-*.js -> dist/ui/...
  '../../dist/ui/invoice-pdf.html', // from src/resources/*.ts (tsx dev)
];

function resolveHtmlPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of HTML_CANDIDATES) {
    const path = resolve(here, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

export const pdfAppResource: Resource = {
  uri: INVOICE_PDF_APP_URI,
  name: 'Visor de factura (PDF)',
  description:
    'Panel interactivo que muestra el PDF de una factura. Lo abre automáticamente ' +
    'el host al llamar a beel_get_company_invoice_pdf.',
  mimeType: MCP_APP_MIME,
};

let injectedHtml: string | null = null;

/** Inject the built HTML (Cloudflare Worker build embeds it as a text module). */
export function setPdfAppHtml(html: string): void {
  injectedHtml = html;
}

/** Read the built HTML; null if the UI bundle is missing (build step not run). */
export function readPdfApp(): { text: string; frameDomains: string[] } | null {
  if (injectedHtml) return { text: injectedHtml, frameDomains: pdfFrameDomains() };
  const path = resolveHtmlPath();
  if (!path) return null;
  return { text: readFileSync(path, 'utf8'), frameDomains: pdfFrameDomains() };
}
