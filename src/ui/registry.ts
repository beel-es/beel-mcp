/**
 * MCP Apps registry — interactive UI panels (SEP-1865 / "MCP Apps").
 *
 * A UI is a `ui://` resource serving HTML (mimetype text/html;profile=mcp-app)
 * rendered by the host (Claude, ChatGPT, …) in a sandboxed iframe. A tool opts
 * into it by carrying `_meta.ui.resourceUri`; the tool's `structuredContent` is
 * delivered to the iframe via the app-bridge.
 *
 * Here we wire the invoice-PDF viewer: when the agent calls the tool that returns
 * a PDF download URL, the host shows the PDF in a side panel.
 */

/** MIME type for MCP App HTML resources (per the ext-apps spec). */
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

/** The invoice PDF viewer resource URI. */
export const INVOICE_PDF_APP_URI = 'ui://beel/invoice-pdf.html';

/**
 * operationId -> UI resource URI. Operations listed here get `_meta.ui.resourceUri`
 * on their tool and have their JSON payload echoed as `structuredContent` so the
 * panel can read it. `getCompanyInvoicePdf` returns `{ download_url, file_name, … }`.
 */
export const UI_TOOLS: Record<string, string> = {
  getCompanyInvoicePdf: INVOICE_PDF_APP_URI,
};

/**
 * Hosts allowed in the iframe CSP `frame-src` for rendering the PDF. The download
 * URL is a presigned MinIO/S3 link (e.g. minio.beel.es); override per environment
 * with BEEL_PDF_DOMAINS (comma-separated origins).
 */
export function pdfFrameDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = env.BEEL_PDF_DOMAINS?.split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return fromEnv && fromEnv.length > 0
    ? fromEnv
    : ['https://minio.beel.es', 'https://app.beel.es'];
}
