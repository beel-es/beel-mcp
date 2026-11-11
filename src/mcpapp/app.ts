/// <reference lib="dom" />
/**
 * Invoice PDF viewer (MCP App), running inside the host's sandbox. It renders the
 * real PDF to a <canvas> with pdf.js, loaded DYNAMICALLY from Cloudflare's CDN
 * rather than inlined — that keeps the ui:// resource tiny and clear of the
 * host's size limit. The PDF bytes themselves arrive through the worker's relay.
 *
 * Bundled into a small IIFE and injected into the HTML by scripts/build-mcpapp.mjs.
 * pdf.js is NOT bundled: it is an import() of an external URL.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { InvoicePdfAppData } from './contract.js';
import { proxiedPdfUrl, renderPdf } from './pdf-render.js';

/**
 * What the panel says. Spanish, because it is product UI the user reads; kept
 * together so the copy is changed in one place rather than hunted for inline.
 */
const UI_TEXT = {
  loading: 'Cargando factura…',
  unavailable: 'No se pudo previsualizar aquí. Usa «Abrir ↗» para ver la factura.',
} as const;

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const pagesEl = byId('pages');
const statusEl = byId('status');
const titleEl = byId('title');
const openEl = byId<HTMLAnchorElement>('open');

function setStatus(text: string): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'flex' : 'none';
}

async function render(data: InvoicePdfAppData | undefined): Promise<void> {
  if (!data?.download_url) return;
  const url = proxiedPdfUrl(data.download_url);
  // `target="_blank"` is blocked inside the sandbox, so we ask the HOST to open
  // the link outside the iframe (the app-bridge's openLink). The href stays for
  // the context menu and accessibility, but the click itself is intercepted.
  openEl.href = url;
  openEl.onclick = (e) => {
    e.preventDefault();
    void app.openLink({ url });
  };
  openEl.style.display = 'inline-flex';
  if (data.file_name) titleEl.textContent = data.file_name;
  setStatus(UI_TEXT.loading);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    await renderPdf(pagesEl, await res.arrayBuffer());
    setStatus('');
  } catch (err) {
    console.error('[beel-pdf-app] render fallback', err);
    setStatus(UI_TEXT.unavailable);
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
app.ontoolresult = (result) => {
  void render(result.structuredContent as InvoicePdfAppData | undefined);
};

void app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyTheme(ctx);
});
