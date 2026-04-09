from __future__ import annotations

from fastmcp import Context

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.runtime import error_response, get_from_lifespan, success_response


def _suggest_next(status: str | None) -> list[str]:
    suggestions = {
        "DRAFT": ["preview_invoice_pdf", "update_invoice_draft", "issue_invoice"],
        "ISSUED": ["get_invoice_pdf_download", "send_invoice_email", "get_verifactu_status"],
        "SENT": ["mark_invoice_paid", "get_verifactu_status"],
        "PAID": ["get_verifactu_status", "export_invoices_excel"],
        "OVERDUE": ["get_invoice_status", "export_invoices_excel"],
    }
    return suggestions.get(status or "", ["get_invoice_status"])


async def get_invoice_status(
    invoice_id: str,
    ctx: Context | None = None,
) -> dict:
    """Recupera el detalle completo de una factura, incluido VeriFactu."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    try:
        result = await invoice_svc.get(invoice_id)
        invoice = result.get("data", {})
        verifactu = invoice.get("verifactu", {})
        return success_response(
            action_taken="invoice_status_retrieved",
            human_summary=(
                f"Factura {invoice.get('invoice_number', 'borrador')}: estado "
                f"{invoice.get('status')}. VeriFactu: "
                f"{verifactu.get('submission_status', 'N/A')}."
            ),
            resource_ids={"invoice_id": invoice_id},
            data=invoice,
            next_actions=_suggest_next(invoice.get("status")),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_status_failed",
            human_summary=f"Error recuperando factura: {exc.message}",
            error=str(exc),
        )


async def get_verifactu_status(
    invoice_id: str,
    ctx: Context | None = None,
) -> dict:
    """Resume el estado de registro VeriFactu de una factura."""
    verifactu_svc = get_from_lifespan(ctx, "verifactu_service")
    try:
        data = await verifactu_svc.get_status(invoice_id)
        status = data.get("submission_status")
        enabled = data.get("verifactu_enabled", False)

        if not enabled:
            summary = "VeriFactu no esta habilitado para esta factura."
        elif status == "ACCEPTED":
            summary = (
                f"VeriFactu aceptado por AEAT. Registro: "
                f"{data.get('registration_number', 'N/A')}."
            )
        elif status == "REJECTED":
            summary = (
                f"VeriFactu rechazado. Error: "
                f"{data.get('error_message', 'sin detalle')}."
            )
        elif status == "PENDING":
            summary = "VeriFactu pendiente de confirmacion por AEAT."
        else:
            summary = f"Estado VeriFactu: {status or 'N/A'}."

        return success_response(
            action_taken="verifactu_status_retrieved",
            human_summary=summary,
            resource_ids={"invoice_id": invoice_id},
            data=data,
            next_actions=["get_invoice_status"] if status == "PENDING" else ["export_invoices_excel"],
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="verifactu_status_failed",
            human_summary=f"Error consultando VeriFactu: {exc.message}",
            error=str(exc),
        )
