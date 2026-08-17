/// <reference lib="dom" />
/**
 * Browser app (MCP App) for the invoice PDF viewer. Runs inside the host's
 * DOUBLE-iframe sandbox (SEP-1865), donde el visor NATIVO de PDF del navegador
 * NO puede pintar un PDF cross-origin. Por eso lo renderizamos nosotros a
 * <canvas> con pdf.js — el patrón estándar de MCP Apps: la app pinta su propio
 * contenido. Si algo falla (worker CSP, red…), caemos al botón "Abrir".
 *
 * El PDF se busca vía el proxy del worker (mcp.beel.es/pdf) declarado en
 * connect-src; el proxy lo sirve inline con CORS para poder leer los bytes.
 *
 * Bundled a un HTML self-contained por scripts/build-ui.mjs.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import * as pdfjsLib from 'pdfjs-dist';

// El código del worker de pdf.js se inyecta como base64 en build time y se
// materializa como blob URL: sin cargas externas (el sandbox las bloquea).
declare const __PDF_WORKER_B64__: string;
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([Uint8Array.from(atob(__PDF_WORKER_B64__), (c) => c.charCodeAt(0))], {
    type: 'text/javascript',
  }),
);

interface PdfData {
  download_url?: string;
  file_name?: string;
  expires_in_seconds?: number;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const pagesEl = byId('pages');
const statusEl = byId('status');
const titleEl = byId('title');
const metaEl = byId('meta');
const openEl = byId<HTMLAnchorElement>('open');

const PDF_PROXY = 'https://mcp.beel.es/pdf';
const viaProxy = (url: string): string => `${PDF_PROXY}?u=${encodeURIComponent(url)}`;

function setStatus(text: string): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'flex' : 'none';
}

/** Renderiza cada página del PDF a un canvas escalado al ancho del contenedor. */
async function renderPdf(bytes: ArrayBuffer): Promise<void> {
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  pagesEl.replaceChildren();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = pagesEl.clientWidth - 24 || 560; // menos el padding
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

async function render(data: PdfData | undefined): Promise<void> {
  const url = data?.download_url;
  if (!url) return;
  const proxied = viaProxy(url);
  openEl.href = proxied;
  openEl.style.display = 'inline-flex';
  if (data.file_name) titleEl.textContent = data.file_name;
  if (data.expires_in_seconds) {
    metaEl.textContent = `enlace válido ~${Math.round(data.expires_in_seconds / 60)} min`;
  }
  setStatus('Cargando factura…');
  try {
    const res = await fetch(proxied);
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    await renderPdf(await res.arrayBuffer());
    setStatus('');
  } catch (err) {
    console.error('[beel-pdf-app] render fallback', err);
    setStatus('No se pudo previsualizar aquí. Usa «Abrir ↗» para verla.');
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
  void render(result.structuredContent as PdfData | undefined);
};

void app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyTheme(ctx);
});
