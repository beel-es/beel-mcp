from __future__ import annotations

from fastmcp import Context
from pydantic import ValidationError

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.policies.confirmations import get_confirmation_message
from beel_mcp.runtime import (
    confirmation_required_response,
    error_response,
    get_from_lifespan,
    success_response,
)
from beel_mcp.schemas import PaymentInfoInput


async def mark_invoice_paid(
    invoice_id: str,
    confirm: bool = False,
    payment_date: str | None = None,
    payment_method: str | None = None,
    iban: str | None = None,
    swift: str | None = None,
    payment_term_days: int | None = None,
    ctx: Context | None = None,
) -> dict:
    """Marca una factura como pagada si esta en el estado permitido."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    if not confirm:
        return confirmation_required_response(
            action="mark_invoice_paid",
            message=(
                f"{get_confirmation_message('mark_invoice_paid')} "
                "Vuelve a llamar con `confirm=true`."
            ),
            next_actions=["get_invoice_status"],
        )
    try:
        payment_info = None
        if payment_method:
            payment_info = PaymentInfoInput(
                method=payment_method,
                iban=iban,
                swift=swift,
                payment_term_days=payment_term_days,
            ).to_api_payload()
        result = await invoice_svc.mark_paid(
            invoice_id,
            payment_date=payment_date,
            payment_method=payment_info,
        )
        invoice = result.get("data", {})
        return success_response(
            action_taken="invoice_marked_paid",
            human_summary=(
                f"Factura {invoice.get('invoice_number', invoice_id)} marcada como pagada."
            ),
            resource_ids={"invoice_id": invoice_id},
            data=invoice,
            next_actions=["get_invoice_status", "export_invoices_excel"],
        )
    except (ValidationError, ValueError) as exc:
        return error_response(
            action_taken="invoice_mark_paid_blocked",
            human_summary=str(exc),
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_mark_paid_failed",
            human_summary=f"Error marcando la factura como pagada: {exc.message}",
            error=str(exc),
        )
