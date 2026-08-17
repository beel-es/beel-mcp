/// <reference lib="dom" />
/**
 * Visor de PDF de factura (MCP App). Corre en el sandbox del host. Renderiza el
 * PDF de verdad a <canvas> con pdf.js — cargado DINÁMICAMENTE desde cdnjs
 * (Cloudflare), no inline (así el recurso ui:// queda diminuto y no revienta el
 * límite de tamaño del host). El binario del PDF llega por el proxy del worker.
 *
 * Se bundlea a un IIFE pequeño e inyecta en el HTML (scripts/build-mcpapp.mjs).
 * pdf.js NO se bundlea: es un import() de una URL (externo).
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

/** URL del PDF a través del proxy (inline + CORS) para poder leer los bytes. */
const proxied = (url: string): string => `${APP_ORIGIN}${PDF_PROXY_PATH}?u=${encodeURIComponent(url)}`;

/** Carga pdf.js de cdnjs una sola vez; fija el worker desde el mismo CDN. */
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

/** Renderiza cada página del PDF a un canvas escalado al ancho del contenedor. */
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
  openEl.href = url;
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
