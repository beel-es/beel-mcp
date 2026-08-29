/**
 * Contract for the invoice-viewer MCP App: the names, URIs and CSP origins shared
 * by the resource, the tool binding, the browser app and the build script.
 *
 * Values specific to the viewer live here; anything shared with the rest of the
 * server comes from shared/defaults.ts, which is the single global source.
 */

import { BEEL_DEFAULTS, ENV_VAR } from '../shared/defaults.js';
import { ambientEnv, readEnvUrl, type EnvRecord } from '../shared/env.js';

/**
 * Public origin of the server, which serves the PDF relay.
 *
 * Resolved per read rather than frozen at import: a deployment under its own
 * domain sets `MCP_PUBLIC_URL`, and a CSP naming the wrong origin blocks the
 * relay the viewer fetches its bytes from — silently, since a blocked fetch
 * looks to the app like a failed one.
 */
export function appOrigin(env: EnvRecord = ambientEnv()): string {
  return readEnvUrl(env, ENV_VAR.publicUrl, BEEL_DEFAULTS.publicUrl);
}

/**
 * The origin the browser bundle uses, which cannot be one of the above: the app
 * runs in the host's sandbox with no access to the deployment's environment, and
 * its bundle is built once. A deployment on another domain has to have it
 * injected at build time.
 */
export const DEFAULT_APP_ORIGIN = BEEL_DEFAULTS.publicUrl;

/**
 * Cloudflare's CDN copy of pdf.js, loaded at runtime rather than inlined: it
 * keeps the ui:// resource small enough for the host's size limit.
 *
 * Loaded without Subresource Integrity, deliberately. The module is fetched by
 * `import()` from an exact pinned version, and a dynamic import takes no
 * integrity attribute — there is no way to state a hash for it. The version pin
 * is what makes the URL immutable on cdnjs; the CSP below is what stops any
 * other origin being reachable at all.
 */
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

export interface AppCsp {
  resourceDomains: string[];
  connectDomains: string[];
}

/**
 * The CSP the resource declares (`_meta.ui.csp`). The app runs in a sandbox with
 * no same-origin privileges, so every origin it may load from or talk to has to
 * be listed explicitly:
 * - resourceDomains: scripts, styles, images and workers → the pdf.js CDN.
 * - connectDomains: fetch → the relay (the PDF bytes) and the CDN (pdf.js chunks).
 */
export function appCsp(env: EnvRecord = ambientEnv()): AppCsp {
  return {
    resourceDomains: [PDFJS_CDN_ORIGIN],
    connectDomains: [appOrigin(env), PDFJS_CDN_ORIGIN],
  };
}

/** The payload the tool hands to the viewer through `structuredContent`. */
export interface InvoicePdfAppData {
  /** Presigned PDF URL; routed through the relay so it is served inline with CORS. */
  download_url: string;
  file_name?: string;
}
