/**
 * Contrato de la MCP App del visor de factura: nombres, URIs y dominios CSP que
 * comparten el recurso, el binding, la app de navegador y el build. Los valores
 * propios del visor viven aquí; los que comparte con el resto del servidor
 * vienen de shared/defaults.ts, que es la única fuente global.
 */

import { BEEL_DEFAULTS } from '../shared/defaults.js';

/** Dominio público del worker (sirve el proxy del PDF). */
export const APP_ORIGIN = BEEL_DEFAULTS.publicUrl;

/** CDN de Cloudflare que sirve pdf.js (self-hosted por Cloudflare, no inline). */
export const PDFJS_CDN_ORIGIN = 'https://cdnjs.cloudflare.com';
export const PDFJS_VERSION = '4.10.38';
export const PDFJS_MODULE_URL = `${PDFJS_CDN_ORIGIN}/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
export const PDFJS_WORKER_URL = `${PDFJS_CDN_ORIGIN}/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

/** Recurso ui:// del visor y su mimetype (perfil MCP Apps). */
export const INVOICE_PDF_APP_URI = 'ui://beel/invoice-pdf.html';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

/** Ruta del proxy que re-sirve la presigned inline con CORS (para el fetch de la app). */
export const PDF_PROXY_PATH = '/pdf';

/** Operación cuyo resultado abre el visor (binding tool ↔ app). */
export const INVOICE_PDF_OPERATION = 'getCompanyInvoicePdf';

/**
 * CSP que declara el recurso (`_meta.ui.csp`). La app corre en un sandbox sin
 * same-origin: se listan explícitamente los orígenes que puede cargar/contactar.
 * - resourceDomains: scripts/estilos/img/worker → cdnjs (pdf.js).
 * - connectDomains: fetch → nuestro proxy (bytes del PDF) + cdnjs (chunks/worker de pdf.js).
 */
export const APP_CSP = {
  resourceDomains: [PDFJS_CDN_ORIGIN],
  connectDomains: [APP_ORIGIN, PDFJS_CDN_ORIGIN],
} as const;

/** Payload que el tool entrega al visor por `structuredContent`. */
export interface InvoicePdfAppData {
  /** URL presignada del PDF (se enruta por el proxy para servirlo inline+CORS). */
  download_url: string;
  file_name?: string;
}
