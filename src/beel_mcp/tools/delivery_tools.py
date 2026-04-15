from __future__ import annotations

from fastmcp import Context

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.policies.confirmations import get_confirmation_message
from beel_mcp.runtime import (
    confirmation_required_response,
    error_response,
    get_from_lifespan,
    success_response,
)


async def send_invoice_email(
    invoice_id: str,
    confirm: bool = False,
    recipients: list[str] | None = None,
    cc: list[str] | None = None,
    subject: str | None = None,
    message: str | None = None,
    attach_pdf: bool = True,
    language: str | None = None,
    ctx: Context | None = None,
) -> dict:
    """Envia una factura por email usando la configuracion de BeeL."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    delivery_svc = get_from_lifespan(ctx, "delivery_service")
    if not confirm:
        return confirmation_required_response(
            action="send_invoice_email",
            message=(
                f"{get_confirmation_message('send_invoice_email')} "
                "Vuelve a llamar con `confirm=true`."
            ),
            next_actions=["get_invoice"],
        )
    try:
        await invoice_svc.ensure_action_allowed(invoice_id, "send_invoice_email")
        result = await delivery_svc.send_email(
            invoice_id,
            recipients=recipients,
            cc=cc,
            subject=subject,
            message=message,
            attach_pdf=attach_pdf,
            language=language,
        )
        data = result.get("data", {})
        return success_response(
            action_taken="invoice_email_sent",
            human_summary=f"Factura enviada a {data.get('sent_to', [])}.",
            resource_ids={"invoice_id": invoice_id, "email_id": data.get("email_id", "")},
            data=data,
            next_actions=["get_invoice", "mark_invoice_paid"],
        )
    except ValueError as exc:
        return error_response(
            action_taken="invoice_email_blocked",
            human_summary=str(exc),
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_email_failed",
            human_summary=f"Error enviando la factura: {exc.message}",
            error=str(exc),
        )
