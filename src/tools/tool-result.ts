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
 * Transforma el payload crudo de un tool en un `CallToolResult`. Devuelve `null`
 * para delegar en el render por defecto (JSON de texto).
 */
export type ResultEnricher = (data: unknown) => Promise<CallToolResult | null>;

/** operationId (contrato OpenAPI) -> enricher. Único punto de registro. */
export const RESULT_ENRICHERS: Record<string, ResultEnricher> = {
  getCompanyInvoicePdf: embedInvoicePdf,
};

/** Aplica el enricher del `operationId`, o `null` si no hay o no aplica. */
export async function enrichToolResult(
  operationId: string | undefined,
  data: unknown,
): Promise<CallToolResult | null> {
  const enricher = operationId ? RESULT_ENRICHERS[operationId] : undefined;
  return enricher ? enricher(data) : null;
}

// ---------------------------------------------------------------------------
// PDF de factura: embeber el binario como recurso MCP `application/pdf` para que
// lo pinte el visor NATIVO del host. Evita el sandbox de MCP Apps (que no
// renderiza PDFs) y no necesita pdf.js ni proxy.
// ---------------------------------------------------------------------------

interface PresignedFile {
  download_url: string;
  file_name?: string;
}

function isPresignedFile(data: unknown): data is PresignedFile {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as Record<string, unknown>).download_url === 'string'
  );
}

async function embedInvoicePdf(data: unknown): Promise<CallToolResult | null> {
  if (!isPresignedFile(data)) return null;
  const res = await fetch(data.download_url).catch(() => null);
  if (!res || !res.ok) return null;
  const fileName = data.file_name ?? 'factura.pdf';
  return {
    content: [
      {
        type: 'resource',
        resource: {
          uri: `beel://invoice/${fileName}`,
          mimeType: 'application/pdf',
          blob: base64(await res.arrayBuffer()),
        },
      },
      { type: 'text', text: `Factura ${fileName} adjunta.` },
    ],
  };
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
