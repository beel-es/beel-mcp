/**
 * Enriquecedores de resultado de tool.
 *
 * Algunos tools devuelven un payload crudo de la API que merece convertirse en
 * contenido MCP más rico que un JSON de texto (p.ej. embeber un PDF para que el
 * host lo previsualice). En vez de repartir `if`s por el handler genérico, cada
 * caso vive aquí como un {@link ResultEnricher} indexado por `operationId`.
 *
 * El handler hace UN lookup: si hay enricher lo aplica; si devuelve `null`
 * (payload inesperado, descarga fallida…) cae al render por defecto. Añadir un
 * caso nuevo = una entrada en {@link RESULT_ENRICHERS}, sin tocar el handler.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Contexto que el handler pasa al enricher: los argumentos del tool y un ejecutor
 * de OTRAS operaciones del contrato por `operationId`. Las RUTAS viven solo en el
 * spec OpenAPI (única fuente de verdad); el enricher nunca hardcodea paths — pide
 * una operación por su id y el spec resuelve la ruta, params y auth de la sesión.
 */
export interface EnricherContext {
  args: Record<string, unknown>;
  callOperation: (operationId: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Transforma el payload crudo de un tool en un `CallToolResult`. Devuelve `null`
 * para delegar en el render por defecto (JSON de texto).
 */
export type ResultEnricher = (data: unknown, ctx: EnricherContext) => Promise<CallToolResult | null>;

/** operationId (contrato OpenAPI) -> enricher. Único punto de registro. */
export const RESULT_ENRICHERS: Record<string, ResultEnricher> = {
  getCompanyInvoicePdf: embedInvoicePdf,
};

/** Aplica el enricher del `operationId`, o `null` si no hay o no aplica. */
export async function enrichToolResult(
  operationId: string | undefined,
  data: unknown,
  ctx: EnricherContext,
): Promise<CallToolResult | null> {
  const enricher = operationId ? RESULT_ENRICHERS[operationId] : undefined;
  return enricher ? enricher(data, ctx) : null;
}

// ---------------------------------------------------------------------------
// PDF de factura. El chat de Claude NO renderiza PDFs inline (el visor nativo
// solo los ofrece como adjunto). Por eso devolvemos DOS cosas honestas:
//   1. una IMAGEN de vista previa (WebP con todas las páginas apiladas), que el
//      host SÍ pinta inline — es una *vista previa*, no el PDF;
//   2. el PDF real como recurso `application/pdf` para abrir/descargar íntegro.
// La imagen se obtiene del endpoint dedicado GET .../invoices/{id}/preview
// (genera-si-falta); si falla, se omite y queda solo el PDF adjunto.
// ---------------------------------------------------------------------------

interface InvoicePdf {
  download_url: string;
  file_name?: string;
}

function isInvoicePdf(data: unknown): data is InvoicePdf {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as Record<string, unknown>).download_url === 'string'
  );
}

/** Descarga una URL y la devuelve como base64 + su content-type; null si falla. */
async function fetchAsBase64(url: string): Promise<{ blob: string; mimeType: string } | null> {
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return { blob: base64(await res.arrayBuffer()), mimeType };
}

/** operationId del preview de factura (ruta y params definidos en el spec OpenAPI). */
const INVOICE_PREVIEW_OPERATION = 'getCompanyInvoicePreview';

/** URL presignada de la imagen de preview vía la operación dedicada; null si falla. */
async function fetchPreviewUrl(ctx: EnricherContext): Promise<string | null> {
  const { company_id, invoice_id } = ctx.args;
  if (typeof company_id !== 'string' || typeof invoice_id !== 'string') return null;
  try {
    const data = (await ctx.callOperation(INVOICE_PREVIEW_OPERATION, {
      company_id,
      invoice_id,
    })) as { image_url?: string } | null;
    return data?.image_url ?? null;
  } catch {
    return null;
  }
}

async function embedInvoicePdf(data: unknown, ctx: EnricherContext): Promise<CallToolResult | null> {
  if (!isInvoicePdf(data)) return null;
  const pdf = await fetchAsBase64(data.download_url);
  if (!pdf) return null; // el PDF es el núcleo: sin él, cae al render por defecto
  const fileName = data.file_name ?? 'factura.pdf';

  const content: CallToolResult['content'] = [];

  // Vista previa inline (imagen). Honesto: es una previsualización, no el PDF.
  const previewUrl = await fetchPreviewUrl(ctx);
  const preview = previewUrl ? await fetchAsBase64(previewUrl) : null;
  if (preview) {
    content.push({ type: 'image', data: preview.blob, mimeType: preview.mimeType });
  }

  // El PDF real, para abrir/descargar íntegro (todas las páginas, texto real).
  content.push({
    type: 'resource',
    resource: { uri: `beel://invoice/${fileName}`, mimeType: 'application/pdf', blob: pdf.blob },
  });

  content.push({
    type: 'text',
    text: preview
      ? `Vista previa de ${fileName} (imagen). El PDF real va adjunto para abrir o descargar.`
      : `PDF ${fileName} adjunto para abrir o descargar.`,
  });

  return { content };
}

/** ArrayBuffer -> base64 por chunks (btoa con spread revienta en buffers grandes). */
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
