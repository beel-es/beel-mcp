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
 * Origen permitido en `connect-src` de la MCP-App. La app hace `fetch` de los
 * bytes del PDF al proxy del worker (`https://mcp.beel.es/pdf`) y los pinta con
 * pdf.js a canvas (el visor nativo no funciona en el sandbox). Solo confiamos en
 * NUESTRO dominio estable. Override con BEEL_PDF_CONNECT_ORIGIN.
 */
export function pdfConnectDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const origin = env.BEEL_PDF_CONNECT_ORIGIN?.trim();
  return [origin && origin.length > 0 ? origin : 'https://mcp.beel.es'];
}

/**
 * Hosts de storage que el proxy `/pdf` puede buscar (guard anti-SSRF: sin esto,
 * el proxy sería un open-relay hacia cualquier host). Son los endpoints públicos
 * de MinIO/S3 desde los que salen las presigned URLs. Override con
 * BEEL_PDF_STORAGE_HOSTS (hostnames separados por coma, sin esquema).
 */
export function pdfStorageHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const fromEnv = env.BEEL_PDF_STORAGE_HOSTS?.split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const defaults = [
    'invoice-storage.internal.example',
    'storage.beel.es',
    'minio.beel.es',
    'app.beel.es',
  ];
  return new Set(fromEnv && fromEnv.length > 0 ? fromEnv : defaults);
}
