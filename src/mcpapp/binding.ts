/**
 * Binding tool ↔ MCP App: qué operación abre qué visor, y cómo extraer del
 * payload crudo de la API los datos que el visor necesita. Único registro; añadir
 * un visor nuevo = una entrada, sin tocar el handler.
 */
import { INVOICE_PDF_APP_URI, INVOICE_PDF_OPERATION, type InvoicePdfAppData } from './contract.js';

/** operationId → recurso ui:// que el host debe renderizar al llamar al tool. */
export const APP_BINDINGS: Readonly<Record<string, string>> = {
  [INVOICE_PDF_OPERATION]: INVOICE_PDF_APP_URI,
};

/** Extrae del resultado de la API los datos del visor; `null` si el payload no aplica. */
export function invoicePdfAppData(data: unknown): InvoicePdfAppData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.download_url !== 'string') return null;
  return {
    download_url: d.download_url,
    file_name: typeof d.file_name === 'string' ? d.file_name : undefined,
  };
}
