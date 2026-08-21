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
import type * as PDFJS from 'pdfjs-dist';
import {
  APP_ORIGIN,
  PDF_PROXY_PATH,
  PDFJS_MODULE_URL,
  PDFJS_WORKER_URL,
  type InvoicePdfAppData,
} from './contract.js';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const pagesEl = byId('pages');
const statusEl = byId('status');
const titleEl = byId('title');
const openEl = byId<HTMLAnchorElement>('open');

/** The PDF URL routed through the relay (inline + CORS) so the bytes are readable. */
const proxied = (url: string): string => `${APP_ORIGIN}${PDF_PROXY_PATH}?u=${encodeURIComponent(url)}`;

/** Load pdf.js from the CDN exactly once, pinning its worker to the same origin. */
let pdfjsPromise: Promise<typeof PDFJS> | null = null;
function loadPdfjs(): Promise<typeof PDFJS> {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_MODULE_URL).then((mod) => {
      const lib = mod as typeof PDFJS;
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'flex' : 'none';
}

/** Render every page of the PDF to a canvas scaled to the container width. */
async function renderCanvases(lib: typeof PDFJS, bytes: ArrayBuffer): Promise<void> {
  const pdf = await lib.getDocument({ data: bytes }).promise;
  pagesEl.replaceChildren();
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const targetWidth = Math.max(pagesEl.clientWidth - 24, 320); // menos el padding
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (targetWidth / base.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport }).promise;
    pagesEl.appendChild(canvas);
  }
}

async function render(data: InvoicePdfAppData | undefined): Promise<void> {
  if (!data?.download_url) return;
  const url = proxied(data.download_url);
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
  setStatus('Cargando factura…');
  try {
    const [lib, res] = await Promise.all([loadPdfjs(), fetch(url)]);
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    await renderCanvases(lib, await res.arrayBuffer());
    setStatus('');
  } catch (err) {
    console.error('[beel-pdf-app] render fallback', err);
    setStatus('No se pudo previsualizar aquí. Usa «Abrir ↗» para ver la factura.');
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
