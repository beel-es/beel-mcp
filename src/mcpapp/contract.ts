/**
 * Contract for the invoice-viewer MCP App: the names, URIs and CSP origins shared
 * by the resource, the tool binding, the browser app and the build script.
 *
 * Values specific to the viewer live here; anything shared with the rest of the
 * server comes from shared/defaults.ts, which is the single global source.
 */

import { BEEL_DEFAULTS } from '../shared/defaults.js';

/** Public origin of the worker, which serves the PDF relay. */
export const APP_ORIGIN = BEEL_DEFAULTS.publicUrl;

/** Cloudflare's CDN copy of pdf.js — loaded at runtime rather than inlined. */
export const PDFJS_CDN_ORIGIN = 'https://cdnjs.cloudflare.com';
export const PDFJS_VERSION = '4.10.38';
export const PDFJS_MODULE_URL = `${PDFJS_CDN_ORIGIN}/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
export const PDFJS_WORKER_URL = `${PDFJS_CDN_ORIGIN}/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

/** The viewer's ui:// resource and its mimetype (the MCP Apps profile). */
export const INVOICE_PDF_APP_URI = 'ui://beel/invoice-pdf.html';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

/** Path of the relay that re-serves the presigned PDF inline with CORS, so the app can fetch it. */
export const PDF_PROXY_PATH = '/pdf';

/** The operation whose result opens the viewer (the tool ↔ app binding). */
export const INVOICE_PDF_OPERATION = 'getCompanyInvoicePdf';

/**
 * The CSP the resource declares (`_meta.ui.csp`). The app runs in a sandbox with
 * no same-origin privileges, so every origin it may load from or talk to has to
 * be listed explicitly:
 * - resourceDomains: scripts, styles, images and workers → the pdf.js CDN.
 * - connectDomains: fetch → our relay (the PDF bytes) and the CDN (pdf.js chunks).
 */
export const APP_CSP = {
  resourceDomains: [PDFJS_CDN_ORIGIN],
  connectDomains: [APP_ORIGIN, PDFJS_CDN_ORIGIN],
} as const;

/** The payload the tool hands to the viewer through `structuredContent`. */
export interface InvoicePdfAppData {
  /** Presigned PDF URL; routed through the relay so it is served inline with CORS. */
  download_url: string;
  file_name?: string;
}
