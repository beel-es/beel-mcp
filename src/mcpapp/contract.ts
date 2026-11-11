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

/** Hosts allowed to embed the viewer (`frame-ancestors`). */
export const APP_HOST_ORIGINS = ['https://claude.ai', 'https://chatgpt.com'] as const;

/**
 * Domains under which a host serves MCP Apps from per-app subdomains, so the
 * viewer's `Origin` is one of them rather than `null`. Claude renders each app
 * at `https://<id>.claudemcpcontent.com`, a subdomain that changes per server.
 */
export const APP_SANDBOX_DOMAINS = ['claudemcpcontent.com'] as const;

/** Whether `origin` is an HTTPS subdomain of a host's MCP Apps sandbox domain. */
export function isAppSandboxOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.origin !== origin) return false;
  const host = url.hostname.toLowerCase();
  return APP_SANDBOX_DOMAINS.some((domain) => host.endsWith(`.${domain}`));
}

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

/**
 * The same policy as a `Content-Security-Policy` meta tag, for a reader that
 * inspects the document itself rather than `_meta.ui.csp`. The inline bundle
 * needs `'unsafe-inline'`; every network origin is one of the two lists above.
 */
export function appCspMeta(csp: AppCsp): string {
  const resources = csp.resourceDomains.join(' ');
  const connect = csp.connectDomains.join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src 'self' data: blob: ${resources}`,
    `font-src ${resources}`,
    `connect-src ${connect}`,
    `worker-src blob: ${resources}`,
    `frame-ancestors ${APP_HOST_ORIGINS.join(' ')}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * The BeeL. app: the day-to-day invoicing workflow in one view (status, invoices,
 * a single invoice with its actions, customers). It holds no data of its own and
 * reads and writes through the server's own tools, so every call goes through
 * the same validation, guardrails and scopes as a call Claude makes.
 */
export const BEEL_APP_URI = 'ui://beel/app.html';

/** The views the app can open on. */
export const BEEL_APP_VIEWS = ['home', 'invoices', 'invoice', 'customers'] as const;
export type BeelAppView = (typeof BEEL_APP_VIEWS)[number];

/** Where the app opens: the `structuredContent` of every result bound to it. */
export interface BeelAppRoute {
  view: BeelAppView;
  company_id?: string;
  invoice_id?: string;
  search?: string;
}

/**
 * Operations whose result opens the app, on the full surface only: creating an
 * invoice lands on it, so the user reviews the draft and issues it from there.
 */
export const BEEL_APP_OPENED_BY: readonly string[] = ['createCompanyInvoice'];

/**
 * The operations the app calls, by operationId. The view derives each tool name
 * with `toolName`, so a renamed operation fails a test here rather than a click
 * in production.
 */
export const BEEL_APP_CALLS = {
  fiscalSummary: 'getCompanyFiscalSummary',
  listInvoices: 'listCompanyInvoices',
  getInvoice: 'getCompanyInvoice',
  issueInvoice: 'issueCompanyInvoice',
  sendInvoice: 'sendCompanyInvoice',
  setInvoiceStatus: 'setCompanyInvoiceStatus',
  invoicePdf: INVOICE_PDF_OPERATION,
  listCustomers: 'listCompanyCustomers',
} as const;

/** The setup report the home view reads: a hand-written tool, so named, not derived. */
export const BEEL_APP_SETUP_TOOL = 'beel_get_setup_status';

/**
 * The brand fonts, served by the server itself under this path. Self-hosted for
 * the same reason the website self-hosts them: a third-party font CDN would hand
 * every user's IP address to that third party.
 */
export const BRAND_FONT_PATH = '/assets/fonts';
export const BRAND_FONT_FILES = ['dm-sans-latin.woff2', 'geist-mono.woff2'] as const;
export type BrandFontFile = (typeof BRAND_FONT_FILES)[number];

/** The BeeL. app's CSP: the viewer's, plus its own origin for the brand fonts. */
function beelAppCsp(env: EnvRecord = ambientEnv()): AppCsp {
  const base = appCsp(env);
  return { ...base, resourceDomains: [...base.resourceDomains, appOrigin(env)] };
}

/** How the host should present an app (`_meta.ui` of its resource contents). */
export interface McpAppPresentation {
  prefersBorder?: boolean;
}

interface McpAppSpec {
  /** The file scripts/build-mcpapp.mjs writes under dist/mcpapp. */
  file: string;
  csp: (env?: EnvRecord) => AppCsp;
  presentation?: McpAppPresentation;
}

/** Every MCP App this server serves, by ui:// URI: the single point of registration. */
export const MCP_APPS: Readonly<Record<string, McpAppSpec>> = {
  [INVOICE_PDF_APP_URI]: { file: 'invoice-pdf.html', csp: appCsp },
  [BEEL_APP_URI]: {
    file: 'beel-app.html',
    csp: beelAppCsp,
    // Opens as a card in the conversation; the user takes it to the larger
    // panel when they want the workspace. It draws its own frame.
    presentation: { prefersBorder: false },
  },
};
