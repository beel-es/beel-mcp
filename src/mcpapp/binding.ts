/**
 * The tool ↔ MCP App binding: which operation opens which viewer, and how to pull
 * the data a viewer needs out of the raw API payload. The single point of
 * registration — a new viewer is one entry here and no change to the handler.
 */
import { INVOICE_PDF_APP_URI, INVOICE_PDF_OPERATION, type InvoicePdfAppData } from './contract.js';

/** operationId → the ui:// resource the host should render when the tool is called. */
export const APP_BINDINGS: Readonly<Record<string, string>> = {
  [INVOICE_PDF_OPERATION]: INVOICE_PDF_APP_URI,
};

/** Extract the viewer's data from an API result; `null` when the payload does not apply. */
export function invoicePdfAppData(data: unknown): InvoicePdfAppData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.download_url !== 'string') return null;
  return {
    download_url: d.download_url,
    file_name: typeof d.file_name === 'string' ? d.file_name : undefined,
  };
}
