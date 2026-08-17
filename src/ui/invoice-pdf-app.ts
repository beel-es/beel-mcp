/// <reference lib="dom" />
/**
 * Browser app (MCP App) for the invoice PDF viewer. Runs inside the host's
 * sandboxed iframe. It receives the `beel_get_company_invoice_pdf` tool result via
 * the app-bridge (`ontoolresult`) and renders the presigned PDF URL in an iframe.
 *
 * Bundled to a self-contained script by scripts/build-ui.mjs and inlined into
 * dist/ui/invoice-pdf.html (served as the `ui://beel/invoice-pdf.html` resource).
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

interface PdfData {
  download_url?: string;
  file_name?: string;
  expires_in_seconds?: number;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const iframe = byId<HTMLIFrameElement>('pdf');
const titleEl = byId('title');
const metaEl = byId('meta');
const openEl = byId<HTMLAnchorElement>('open');
const emptyEl = byId('empty');

/**
 * El iframe NO puede apuntar a la presigned URL directa: su host de storage no
 * está en el frame-src y viene con `attachment` (fuerza descarga). La enrutamos
 * por el proxy del worker (mismo dominio del MCP), que la re-sirve `inline`.
 */
const PDF_PROXY = 'https://mcp.beel.es/pdf';
const viaProxy = (url: string): string => `${PDF_PROXY}?u=${encodeURIComponent(url)}`;

function render(data: PdfData | undefined): void {
  const url = data?.download_url;
  if (!url) return;
  const proxied = viaProxy(url);
  iframe.src = proxied;
  iframe.style.display = 'block';
  emptyEl.style.display = 'none';
  openEl.href = proxied;
  openEl.style.display = 'inline-flex';
  if (data.file_name) titleEl.textContent = data.file_name;
  if (data.expires_in_seconds) {
    metaEl.textContent = `enlace válido ~${Math.round(data.expires_in_seconds / 60)} min`;
  }
}

function applyTheme(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

const app = new App({ name: 'BeeL Invoice PDF', version: '1.0.0' });
app.onerror = (err) => console.error('[beel-pdf-app]', err);
app.onhostcontextchanged = applyTheme;
// The host delivers the result of the tool that opened this panel.
app.ontoolresult = (result) => render(result.structuredContent as PdfData | undefined);

void app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyTheme(ctx);
});
