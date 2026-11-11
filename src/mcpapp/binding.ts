/**
 * The tool ↔ MCP App binding: which operation opens which viewer, and how to pull
 * the data a viewer needs out of the raw API payload. The single point of
 * registration — a new viewer is one entry here and no change to the handler.
 */
import type { ApiTool } from '../tools/api-tools.js';
import {
  BEEL_APP_OPENED_BY,
  BEEL_APP_URI,
  INVOICE_PDF_APP_URI,
  INVOICE_PDF_OPERATION,
  type BeelAppRoute,
  type InvoicePdfAppData,
} from './contract.js';

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

/**
 * Bind the operations in BEEL_APP_OPENED_BY to the BeeL. app. Applied to the full
 * surface only: the ChatGPT surface was reviewed without the app, so its tools
 * keep the metadata they were published with.
 */
export function withBeelAppBinding(tools: ApiTool[]): ApiTool[] {
  return tools.map((t) =>
    BEEL_APP_OPENED_BY.includes(t.operation.operationId)
      ? { ...t, tool: { ...t.tool, _meta: { ...t.tool._meta, ui: { resourceUri: BEEL_APP_URI } } } }
      : t,
  );
}

/** The app route for an invoice payload; `null` when the payload has no id. */
export function invoiceAppRoute(data: unknown): BeelAppRoute | null {
  if (!data || typeof data !== 'object') return null;
  const id = (data as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? { view: 'invoice', invoice_id: id } : null;
}
