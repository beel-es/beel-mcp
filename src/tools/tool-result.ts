/**
 * Enriquecedores de resultado de tool: convierten el payload crudo de la API en
 * un `CallToolResult` más rico (structuredContent para una MCP App + adjuntos).
 * Cada caso vive aquí, indexado por `operationId`; el handler hace UN lookup.
 * Añadir un caso = una entrada en {@link RESULT_ENRICHERS}.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { invoicePdfAppData } from '../mcpapp/binding.js';
import { INVOICE_PDF_OPERATION } from '../mcpapp/contract.js';

/** Transforma el payload de un tool en un CallToolResult; `null` = render por defecto. */
export type ResultEnricher = (data: unknown) => Promise<CallToolResult | null>;

/** operationId → enricher. Único punto de registro. */
export const RESULT_ENRICHERS: Record<string, ResultEnricher> = {
  [INVOICE_PDF_OPERATION]: buildInvoicePdfResult,
};

/** Aplica el enricher del operationId, o `null` si no hay o no aplica. */
export async function enrichToolResult(
  operationId: string | undefined,
  data: unknown,
): Promise<CallToolResult | null> {
  const enricher = operationId ? RESULT_ENRICHERS[operationId] : undefined;
  return enricher ? enricher(data) : null;
}

// ---------------------------------------------------------------------------
// PDF de factura: el resultado alimenta la MCP App (visor, vía structuredContent)
// y adjunta el PDF real como recurso `application/pdf` para descargar / abrir a
// tamaño completo o en hosts sin MCP Apps. El binding tool↔app lo declara
// api-tools (_meta.ui.resourceUri); aquí solo damos los datos y el adjunto.
// ---------------------------------------------------------------------------

async function buildInvoicePdfResult(data: unknown): Promise<CallToolResult | null> {
  const appData = invoicePdfAppData(data);
  if (!appData) return null;
  const fileName = appData.file_name ?? 'factura.pdf';

  const content: CallToolResult['content'] = [];
  const pdf = await fetchAsBase64(appData.download_url);
  if (pdf) {
    content.push({
      type: 'resource',
      resource: { uri: `beel://invoice/${fileName}`, mimeType: 'application/pdf', blob: pdf },
    });
  }
  content.push({
    type: 'text',
    text: pdf
      ? `Factura ${fileName}: visor interactivo arriba; PDF adjunto para abrir o descargar.`
      : `Factura ${fileName} (el PDF no pudo adjuntarse; reintenta).`,
  });

  const result: CallToolResult = { content };
  // structuredContent alimenta el visor de la MCP App.
  result.structuredContent = appData as unknown as Record<string, unknown>;
  return result;
}

/** Descarga una URL y la devuelve como base64; null si falla. */
async function fetchAsBase64(url: string): Promise<string | null> {
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  return base64(await res.arrayBuffer());
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
