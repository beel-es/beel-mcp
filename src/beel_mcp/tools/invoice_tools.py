from __future__ import annotations

from typing import Any

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
from beel_mcp.schemas import (
    CreateInvoiceInput,
    PaymentInfoInput,
    RecipientInput,
    UpdateInvoiceInput,
)


async def create_invoice_draft(
    lines: list[dict[str, Any]],
    customer_id: str | None = None,
    recipient: dict[str, Any] | None = None,
    due_date: str | None = None,
    operation_date: str | None = None,
    series_id: str | None = None,
    payment_info: dict[str, Any] | None = None,
    notes: str | None = None,
    invoice_type: str = "STANDARD",
    rectified_invoice_id: str | None = None,
    rectification_reason: str | None = None,
    verifactu_enabled: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Crea una factura en estado DRAFT a partir de customer_id o recipient ad-hoc."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    try:
        if customer_id and recipient:
            raise ValueError("Usa `customer_id` o `recipient`, pero no ambos.")
        if not customer_id and not recipient:
            raise ValueError("Debes informar `customer_id` o `recipient`.")

        recipient_input = (
            RecipientInput(customer_id=customer_id)
            if customer_id
            else RecipientInput.model_validate(recipient)
        )
        payment_input = (
            PaymentInfoInput.model_validate(payment_info) if payment_info else None
        )
        payload = CreateInvoiceInput(
            type=invoice_type,
            recipient=recipient_input,
            lines=lines,
            due_date=due_date,
            operation_date=operation_date,
            series_id=series_id,
            payment_info=payment_input,
            notes=notes,
            rectified_invoice_id=rectified_invoice_id,
            rectification_reason=rectification_reason,
            verifactu_enabled=verifactu_enabled,
        )
        result = await invoice_svc.create_draft(payload)
        invoice = result.get("data", {})
        return success_response(
            action_taken="invoice_created_in_draft",
            human_summary=(
                f"Factura borrador creada. Total: "
                f"{invoice.get('totals', {}).get('invoice_total', 'N/A')} EUR."
            ),
            resource_ids={
                "invoice_id": invoice.get("id", ""),
                "customer_id": invoice.get("recipient", {}).get("customer_id", ""),
            },
            data=invoice,
            next_actions=["preview_invoice_pdf", "update_invoice_draft", "issue_invoice"],
        )
    except (ValidationError, ValueError) as exc:
        return error_response(
            action_taken="invoice_draft_validation_failed",
            human_summary="Los datos de la factura no son validos.",
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_draft_creation_failed",
            human_summary=f"Error creando borrador: {exc.message}",
            error=str(exc),
        )


async def update_invoice_draft(
    invoice_id: str,
    lines: list[dict[str, Any]] | None = None,
    recipient: dict[str, Any] | None = None,
    due_date: str | None = None,
    operation_date: str | None = None,
    series_id: str | None = None,
    payment_info: dict[str, Any] | None = None,
    notes: str | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Actualiza una factura borrador; bloquea cualquier otro estado."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    try:
        payload = UpdateInvoiceInput(
            lines=lines,
            recipient=RecipientInput.model_validate(recipient) if recipient else None,
            due_date=due_date,
            operation_date=operation_date,
            series_id=series_id,
            payment_info=PaymentInfoInput.model_validate(payment_info)
            if payment_info
            else None,
            notes=notes,
        )
        result = await invoice_svc.update_draft(invoice_id, payload)
        invoice = result.get("data", {})
        return success_response(
            action_taken="invoice_draft_updated",
            human_summary="Factura borrador actualizada correctamente.",
            resource_ids={"invoice_id": invoice_id},
            data=invoice,
            next_actions=["preview_invoice_pdf", "issue_invoice"],
        )
    except (ValidationError, ValueError) as exc:
        return error_response(
            action_taken="invoice_update_validation_failed",
            human_summary="Los datos de actualizacion no son validos.",
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_draft_update_failed",
            human_summary=f"Error actualizando borrador: {exc.message}",
            error=str(exc),
        )


async def issue_invoice(
    invoice_id: str,
    confirm: bool = False,
    wait_for_pdf: bool = True,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Emite una factura DRAFT y, opcionalmente, espera a que el PDF exista."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    if not confirm:
        return confirmation_required_response(
            action="issue_invoice",
            message=(
                f"{get_confirmation_message('issue_invoice')} "
                "Vuelve a llamar con `confirm=true` para continuar."
            ),
            next_actions=["preview_invoice_pdf"],
        )
    try:
        result = await invoice_svc.issue(invoice_id, wait_for_pdf=wait_for_pdf)
        invoice = result.get("data", {})
        return success_response(
            action_taken="invoice_issued",
            human_summary=(
                f"Factura emitida. Numero: {invoice.get('invoice_number', 'N/A')}. "
                f"Estado: {invoice.get('status', 'ISSUED')}."
            ),
            resource_ids={"invoice_id": invoice_id},
            data=invoice,
            next_actions=["get_invoice_pdf_download", "send_invoice_email", "get_verifactu_status"],
        )
    except ValueError as exc:
        return error_response(
            action_taken="invoice_issue_blocked",
            human_summary=str(exc),
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoice_issue_failed",
            human_summary=f"Error emitiendo factura: {exc.message}",
            error=str(exc),
        )


async def list_invoices(
    page: int = 1,
    limit: int = 20,
    search: str | None = None,
    status: str | None = None,
    invoice_type: str | None = None,
    customer_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    invoice_number: str | None = None,
    recipient_name: str | None = None,
    recipient_nif: str | None = None,
    series_code: str | None = None,
    taxable_base_min: float | None = None,
    taxable_base_max: float | None = None,
    total_min: float | None = None,
    total_max: float | None = None,
    verifactu_status: str | None = None,
    sort_by: str | None = None,
    sort_order: str = "desc",
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Lista facturas existentes con filtros (estado, cliente, rango de fechas, busqueda libre, VeriFactu, importes) y paginacion."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    params: dict[str, Any] = {
        "page": page,
        "limit": limit,
        "search": search,
        "status": status,
        "type": invoice_type,
        "customer_id": customer_id,
        "date_from": date_from,
        "date_to": date_to,
        "invoice_number": invoice_number,
        "recipient_name": recipient_name,
        "recipient_nif": recipient_nif,
        "series_code": series_code,
        "taxable_base_min": taxable_base_min,
        "taxable_base_max": taxable_base_max,
        "total_min": total_min,
        "total_max": total_max,
        "verifactu_status": verifactu_status,
        "sort_by": sort_by,
        "sort_order": sort_order,
    }
    params = {k: v for k, v in params.items() if v is not None}
    try:
        result = await invoice_svc.list_invoices(**params)
        data = result.get("data", {})
        invoices = data.get("invoices", []) or []
        pagination = data.get("pagination", {}) or {}
        total_items = pagination.get("total_items", len(invoices))
        current_page = pagination.get("current_page", page)
        total_pages = pagination.get("total_pages", 1)
        summary = (
            f"{total_items} facturas encontradas. "
            f"Pagina {current_page}/{total_pages} ({len(invoices)} en esta pagina)."
        )
        return success_response(
            action_taken="invoices_listed",
            human_summary=summary,
            resource_ids={},
            data=data,
            next_actions=["get_invoice", "export_invoices_excel"],
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="invoices_list_failed",
            human_summary=f"Error listando facturas: {exc.message}",
            error=str(exc),
        )
