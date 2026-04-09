from __future__ import annotations

from fastmcp import Context

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.policies.confirmations import get_confirmation_message
from beel_mcp.policies.nif_policy import evaluate_nif_result
from beel_mcp.runtime import (
    confirmation_required_response,
    error_response,
    get_from_lifespan,
    success_response,
)


async def ensure_customer_ready_for_invoicing(
    nif: str | None = None,
    email: str | None = None,
    legal_name: str | None = None,
    validate_nif_flag: bool = True,
    ctx: Context | None = None,
) -> dict:
    """Resuelve un cliente y valida su NIF antes de facturar si se solicita."""
    customer_svc = get_from_lifespan(ctx, "customer_service")
    nif_svc = get_from_lifespan(ctx, "nif_service")
    try:
        result = await customer_svc.find_or_update(
            nif=nif,
            email=email,
            legal_name=legal_name,
        )

        if result["status"] == "not_found":
            return success_response(
                action_taken="customer_not_found",
                human_summary=(
                    "Cliente no encontrado. Debes crearlo antes de facturar."
                ),
                data=result["search_criteria"],
                next_actions=["create_customer"],
            )

        if result["status"] == "ambiguous":
            return success_response(
                action_taken="customer_ambiguous",
                human_summary="La busqueda devolvio multiples clientes; hay que desambiguar.",
                data=result,
                next_actions=["search_customers"],
            )

        customer = result["customer"]
        nif_status = None
        policy = {
            "can_proceed": True,
            "warning": None,
            "recommendation": "Cliente encontrado.",
        }

        if validate_nif_flag and customer.get("nif"):
            nif_result = await nif_svc.validate(
                customer["nif"],
                customer.get("legal_name"),
            )
            nif_data = nif_result.get("data", {})
            nif_status = nif_data.get("status")
            policy = evaluate_nif_result(nif_status)

        return success_response(
            action_taken="customer_ready"
            if policy["can_proceed"]
            else "customer_blocked_by_nif",
            human_summary=(
                f"Cliente: {customer.get('legal_name')}. "
                f"NIF: {customer.get('nif', 'N/A')} ({nif_status or 'no validado'}). "
                f"{policy['recommendation']}"
            ),
            resource_ids={"customer_id": customer.get("id", "")},
            data={
                "customer": customer,
                "nif_validation": {
                    "status": nif_status,
                    "can_proceed": policy["can_proceed"],
                    "warning": policy["warning"],
                },
            },
            next_actions=["create_invoice_draft"]
            if policy["can_proceed"]
            else ["validate_nif"],
        )
    except (ValueError, BeelApiError) as exc:
        return error_response(
            action_taken="ensure_customer_ready_failed",
            human_summary=f"Error resolviendo cliente: {exc}",
            error=str(exc),
        )


async def issue_send_and_track_invoice(
    invoice_id: str,
    confirm: bool = False,
    send_email: bool = True,
    wait_for_pdf: bool = True,
    ctx: Context | None = None,
) -> dict:
    """Emite una factura, opcionalmente la envia y devuelve su estado inicial."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    delivery_svc = get_from_lifespan(ctx, "delivery_service")
    if not confirm:
        return confirmation_required_response(
            action="issue_send_and_track_invoice",
            message=(
                f"{get_confirmation_message('issue_send_and_track_invoice')} "
                "Vuelve a llamar con `confirm=true`."
            ),
            next_actions=["get_invoice_status"],
        )

    steps: list[str] = []
    try:
        issue_result = await invoice_svc.issue(invoice_id, wait_for_pdf=wait_for_pdf)
        invoice = issue_result.get("data", {})
        steps.append(f"emitida:{invoice.get('invoice_number', 'N/A')}")

        email_data = None
        if send_email:
            email_result = await delivery_svc.send_email(invoice_id)
            email_data = email_result.get("data", {})
            steps.append("email_enviado")

        verifactu = invoice.get("verifactu", {})
        verifactu_status = verifactu.get("submission_status")
        steps.append(f"verifactu:{verifactu_status or 'N/A'}")

        return success_response(
            action_taken="invoice_issued_sent_tracked",
            human_summary=" | ".join(steps),
            resource_ids={"invoice_id": invoice_id},
            data={
                "invoice": invoice,
                "email": email_data,
                "verifactu_status": verifactu_status,
            },
            next_actions=["get_verifactu_status", "mark_invoice_paid"],
        )
    except (ValueError, BeelApiError) as exc:
        return error_response(
            action_taken="issue_send_and_track_failed",
            human_summary=f"Workflow interrumpido. Pasos completados: {steps}.",
            error=str(exc),
        )


async def follow_up_unpaid_invoices(
    status: str = "OVERDUE",
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 50,
    ctx: Context | None = None,
) -> dict:
    """Genera un informe compacto de facturas vencidas o pendientes de cobro."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    try:
        result = await invoice_svc.list_invoices(
            status=status,
            date_from=date_from,
            date_to=date_to,
            limit=limit,
            sort_by="due_date",
            sort_order="asc",
        )
        invoices = result.get("data", {}).get("invoices", [])
        summary_rows = []
        total_pending = 0.0

        for invoice in invoices:
            total = float(invoice.get("totals", {}).get("invoice_total", 0) or 0)
            total_pending += total
            summary_rows.append(
                {
                    "invoice_id": invoice.get("id"),
                    "invoice_number": invoice.get("invoice_number"),
                    "customer": invoice.get("recipient", {}).get("legal_name"),
                    "status": invoice.get("status"),
                    "due_date": invoice.get("due_date"),
                    "total": total,
                }
            )

        return success_response(
            action_taken="unpaid_invoices_report_generated",
            human_summary=(
                f"{len(invoices)} facturas en estado {status}. "
                f"Total pendiente: {total_pending:.2f} EUR."
            ),
            data={
                "count": len(invoices),
                "total_pending": total_pending,
                "invoices": summary_rows,
            },
            next_actions=["export_invoices_excel", "get_invoice_status"],
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="unpaid_invoices_report_failed",
            human_summary=f"Error generando seguimiento: {exc.message}",
            error=str(exc),
        )
