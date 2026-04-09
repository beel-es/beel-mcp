from __future__ import annotations

from typing import Any

from fastmcp import Context
from pydantic import ValidationError

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.runtime import error_response, get_from_lifespan, success_response
from beel_mcp.schemas import (
    AddressInput,
    AlternativeIdInput,
    CreateCustomerInput,
    PaymentInfoInput,
    UpdateCustomerInput,
)


async def search_customers(
    query: str | None = None,
    nif: str | None = None,
    email: str | None = None,
    legal_name: str | None = None,
    page: int = 1,
    limit: int = 20,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Busca clientes por texto libre, NIF, email o nombre fiscal."""
    customer_svc = get_from_lifespan(ctx, "customer_service")
    try:
        result = await customer_svc.search(
            search=query,
            nif=nif,
            email=email,
            legal_name=legal_name,
            page=page,
            limit=limit,
        )
        customers = result.get("data", {}).get("customers", [])
        pagination = result.get("data", {}).get("pagination", {})
        return success_response(
            action_taken="customers_searched",
            human_summary=f"Se encontraron {len(customers)} clientes.",
            data={"customers": customers, "pagination": pagination},
            next_actions=["create_customer"] if not customers else ["upsert_customer", "create_invoice_draft"],
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="customer_search_failed",
            human_summary=f"Error buscando clientes: {exc.message}",
            error=str(exc),
        )


async def create_customer(
    legal_name: str,
    street: str,
    number: str,
    postal_code: str,
    city: str,
    province: str,
    country: str = "España",
    country_code: str = "ES",
    nif: str | None = None,
    alternative_id_type: str | None = None,
    alternative_id_number: str | None = None,
    alternative_id_country_code: str | None = None,
    trade_name: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    billing_emails: list[str] | None = None,
    contact_person: str | None = None,
    notes: str | None = None,
    preferred_payment_method: str | None = None,
    preferred_payment_iban: str | None = None,
    preferred_payment_swift: str | None = None,
    preferred_payment_term_days: int | None = None,
    general_discount: float | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Crea un cliente en BeeL con NIF o identificador alternativo."""
    customer_svc = get_from_lifespan(ctx, "customer_service")
    try:
        alternative_id = None
        if alternative_id_type and alternative_id_number and alternative_id_country_code:
            alternative_id = AlternativeIdInput(
                type=alternative_id_type,
                number=alternative_id_number,
                country_code=alternative_id_country_code,
            )

        preferred_payment = None
        if preferred_payment_method:
            preferred_payment = PaymentInfoInput(
                method=preferred_payment_method,
                iban=preferred_payment_iban,
                swift=preferred_payment_swift,
                payment_term_days=preferred_payment_term_days,
            )

        payload = CreateCustomerInput(
            legal_name=legal_name,
            address=AddressInput(
                street=street,
                number=number,
                postal_code=postal_code,
                city=city,
                province=province,
                country=country,
                country_code=country_code,
            ),
            nif=nif.upper() if nif else None,
            alternative_id=alternative_id,
            trade_name=trade_name,
            email=email,
            phone=phone,
            billing_emails=billing_emails,
            contact_person=contact_person,
            notes=notes,
            preferred_payment_method=preferred_payment,
            general_discount=general_discount,
        )
        result = await customer_svc.create(payload)
        customer = result.get("data", {})
        return success_response(
            action_taken="customer_created",
            human_summary=f"Cliente `{customer.get('legal_name', legal_name)}` creado correctamente.",
            resource_ids={"customer_id": customer.get("id", "")},
            data=customer,
            next_actions=["validate_nif", "create_invoice_draft"],
        )
    except (ValidationError, ValueError) as exc:
        return error_response(
            action_taken="customer_validation_failed",
            human_summary="Los datos del cliente no son validos.",
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="customer_creation_failed",
            human_summary=f"Error creando cliente: {exc.message}",
            error=str(exc),
        )


async def upsert_customer(
    search_nif: str | None = None,
    search_email: str | None = None,
    search_legal_name: str | None = None,
    update_data: dict[str, Any] | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Busca un cliente y lo actualiza si `update_data` viene informado."""
    customer_svc = get_from_lifespan(ctx, "customer_service")
    try:
        update_payload = (
            UpdateCustomerInput.model_validate(update_data) if update_data is not None else None
        )
        result = await customer_svc.find_or_update(
            nif=search_nif,
            email=search_email,
            legal_name=search_legal_name,
            update_data=update_payload,
        )

        status = result["status"]
        if status == "not_found":
            return success_response(
                action_taken="customer_not_found",
                human_summary="No se encontro ningun cliente con los criterios indicados.",
                data=result["search_criteria"],
                next_actions=["create_customer"],
            )
        if status == "ambiguous":
            return success_response(
                action_taken="customer_ambiguous",
                human_summary="La busqueda devolvio multiples clientes; hay que desambiguar.",
                data={
                    "search_criteria": result["search_criteria"],
                    "matches": result["matches"],
                },
                next_actions=["search_customers"],
            )

        customer = result["customer"]
        action_taken = "customer_updated" if result["updated"] else "customer_found"
        return success_response(
            action_taken=action_taken,
            human_summary=f"Cliente resuelto: {customer.get('legal_name')}.",
            resource_ids={"customer_id": customer.get("id", "")},
            data=customer,
            next_actions=["validate_nif", "create_invoice_draft"],
        )
    except (ValidationError, ValueError) as exc:
        return error_response(
            action_taken="customer_upsert_validation_failed",
            human_summary="Los criterios de busqueda o actualizacion no son validos.",
            error=str(exc),
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="customer_upsert_failed",
            human_summary=f"Error resolviendo cliente: {exc.message}",
            error=str(exc),
        )
