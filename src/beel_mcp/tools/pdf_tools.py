from __future__ import annotations

import base64

from fastmcp import Context
from fastmcp.tools import ToolResult

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.runtime import (
    error_response,
    get_from_lifespan,
    get_settings_from_ctx,
    inline_binary_result,
    success_response,
)


def _client_supports_apps(ctx: Context) -> bool:
    """Detecta si el cliente MCP soporta la extension Apps."""
    try:
        from fastmcp.apps import UI_EXTENSION_ID
        return ctx.client_supports_extension(UI_EXTENSION_ID)
    except (ImportError, AttributeError):
        return False


async def preview_invoice_pdf(
    invoice_id: str,
    ctx: Context | None = None,
) -> ToolResult | dict:
    """Genera el PDF de previsualizacion de una factura en borrador.

    Si el cliente soporta MCP Apps, muestra el PDF renderizado en un visor
    interactivo con navegacion de paginas, zoom y descarga.
    Si no, devuelve el binario base64 como metadata.
    """
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    pdf_svc = get_from_lifespan(ctx, "pdf_service")
    settings = get_settings_from_ctx(ctx)
    try:
        await invoice_svc.ensure_action_allowed(invoice_id, "preview_invoice_pdf")
        pdf_bytes = await pdf_svc.preview_draft(invoice_id)

        # --- Ruta MCP Apps: visor interactivo en iframe ---
        if ctx and _client_supports_apps(ctx):
            b64 = base64.b64encode(pdf_bytes).decode("ascii")
            return ToolResult(
                content=(
                    f"Preview PDF generado para factura {invoice_id} "
                    f"({len(pdf_bytes):,} bytes). "
                    "Se muestra en el visor interactivo."
                ),
                structured_content={
                    "pdf_base64": b64,
                    "invoice_id": invoice_id,
                    "size_bytes": len(pdf_bytes),
                },
            )

        # --- Ruta clasica: base64 inline como metadata ---
        payload = inline_binary_result(
            pdf_bytes,
            file_name=f"invoice-preview-{invoice_id}.pdf",
            mime_type="application/pdf",
            settings=settings,
        )
        summary = "Preview PDF generado."
        if not payload["inline_available"]:
            summary = (
                "Preview PDF generado, pero no se inlinea por superar el limite configurado."
            )
        return success_response(
            action_taken="invoice_pdf_preview_generated",
            human_summary=summary,
            resource_ids={"invoice_id": invoice_id},
            data=payload,
            next_actions=["update_invoice_draft", "issue_invoice"],
        )
    except ValueError as exc:
        return error_response(
            action_taken="invoice_pdf_preview_blocked",
            human_summary=str(exc),
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_pdf_preview_failed",
            human_summary=f"Error generando preview PDF: {exc.message}",
            error=str(exc),
        )


async def get_invoice_pdf_download(
    invoice_id: str,
    ctx: Context | None = None,
) -> dict:
    """Devuelve una URL temporal de descarga del PDF definitivo."""
    pdf_svc = get_from_lifespan(ctx, "pdf_service")
    try:
        result = await pdf_svc.get_download_url(invoice_id)
        data = result.get("data", {})
        return success_response(
            action_taken="invoice_pdf_download_url_generated",
            human_summary=(
                f"URL de descarga generada. Caduca en "
                f"{data.get('expires_in_seconds', 'N/A')} segundos."
            ),
            resource_ids={"invoice_id": invoice_id},
            data=data,
            next_actions=["send_invoice_email"],
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_pdf_download_failed",
            human_summary=(
                f"Error obteniendo el PDF: {exc.message}. "
                "Si la factura acaba de emitirse, reintenta en unos segundos."
            ),
            error=str(exc),
        )
