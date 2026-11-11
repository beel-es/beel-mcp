/// <reference lib="dom" />
/**
 * PDF rendering shared by the MCP Apps: pdf.js loaded once from the CDN (never
 * bundled), and every page drawn to a canvas sized to its container. The bytes
 * come through the worker's relay, which serves them inline with CORS.
 */
import type * as PDFJS from 'pdfjs-dist';
import {
  DEFAULT_APP_ORIGIN,
  PDF_PROXY_PATH,
  PDFJS_MODULE_URL,
  PDFJS_WORKER_URL,
} from './contract.js';

/** Widest a rendered page may be, and the padding taken off the container for it. */
const PAGE_PADDING_PX = 24;
const MIN_PAGE_WIDTH_PX = 320;
/** Above 2× the extra canvas pixels cost memory without being visible. */
const MAX_DEVICE_PIXEL_RATIO = 2;

/** The PDF URL routed through the relay (inline + CORS) so the bytes are readable. */
export const proxiedPdfUrl = (url: string): string =>
  `${DEFAULT_APP_ORIGIN}${PDF_PROXY_PATH}?u=${encodeURIComponent(url)}`;

/** Load pdf.js from the CDN exactly once, pinning its worker to the same origin. */
let pdfjsPromise: Promise<typeof PDFJS> | null = null;
export function loadPdfjs(): Promise<typeof PDFJS> {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_MODULE_URL).then((mod) => {
      const lib = mod as typeof PDFJS;
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

/** Render every page of the PDF into `container`, scaled to its width. */
export async function renderPdf(container: HTMLElement, bytes: ArrayBuffer): Promise<void> {
  const lib = await loadPdfjs();
  // pdf.js takes ownership of the buffer it is given; a copy keeps the caller's
  // bytes usable (the app also offers them as a download).
  const pdf = await lib.getDocument({ data: bytes.slice(0) }).promise;
  container.replaceChildren();
  const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  const targetWidth = Math.max(container.clientWidth - PAGE_PADDING_PX, MIN_PAGE_WIDTH_PX);
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
    container.appendChild(canvas);
  }
}
