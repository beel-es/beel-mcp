from __future__ import annotations

from fastmcp import Context

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.policies.confirmations import get_confirmation_message
from beel_mcp.runtime import (
    confirmation_required_response,
    error_response,
    get_from_lifespan,
    get_settings_from_ctx,
    inline_binary_result,
    success_response,
)


async def export_invoices_excel(
    invoice_ids: list[str] | None = None,
    status: str | None = None,
    invoice_type: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    customer_id: str | None = None,
    format_type: str = "SUMMARY",
    confirm: bool = False,
    ctx: Context | None = None,
) -> dict:
    """Exporta facturas a Excel y las inlinea solo si el tamano lo permite."""
    export_svc = get_from_lifespan(ctx, "export_service")
    settings = get_settings_from_ctx(ctx)
    if not confirm:
        return confirmation_required_response(
            action="export_invoices_excel",
            message=(
                f"{get_confirmation_message('export_invoices_excel')} "
                "Vuelve a llamar con `confirm=true`."
            ),
            next_actions=["follow_up_unpaid_invoices"],
        )
    try:
        excel_bytes = await export_svc.export_excel(
            invoice_ids=invoice_ids,
            status=status,
            invoice_type=invoice_type,
            date_from=date_from,
            date_to=date_to,
            customer_id=customer_id,
            format_type=format_type,
        )
        payload = inline_binary_result(
            excel_bytes,
            file_name="beel-export.xlsx",
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            settings=settings,
        )
        summary = f"Exportacion Excel generada en formato {format_type}."
        next_actions: list[str] = []
        if not payload["inline_available"]:
            summary = (
                f"Exportacion Excel generada en formato {format_type}, pero el archivo "
                "supera el limite inline. Reduce el rango o filtra por menos facturas."
            )
            next_actions = ["export_invoices_excel con filtros mas pequenos"]
        return success_response(
            action_taken="invoices_exported_to_excel",
            human_summary=summary,
            data=payload,
            next_actions=next_actions,
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_export_failed",
            human_summary=f"Error exportando facturas: {exc.message}",
            error=str(exc),
        )
