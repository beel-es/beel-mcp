from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


PaymentMethod = Literal[
    "NONE",
    "BANK_TRANSFER",
    "CARD",
    "CASH",
    "CHECK",
    "DIRECT_DEBIT",
    "OTHER",
]
TaxType = Literal["IVA", "IGIC", "IPSI", "OTHER"]
InvoiceType = Literal["STANDARD", "SIMPLIFIED", "CORRECTIVE"]


class ToolResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: bool
    action_taken: str
    human_summary: str
    resource_ids: dict[str, str] = Field(default_factory=dict)
    next_recommended_actions: list[str] = Field(default_factory=list)
    data: Any | None = None
    error: str | None = None


class AddressInput(BaseModel):
    street: str
    number: str
    postal_code: str
    city: str
    province: str
    country: str = "España"
    country_code: str = "ES"
    floor: str | None = None
    door: str | None = None

    def to_api_payload(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class AlternativeIdInput(BaseModel):
    type: str
    number: str
    country_code: str

    def to_api_payload(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class PaymentInfoInput(BaseModel):
    method: PaymentMethod
    iban: str | None = None
    swift: str | None = None
    payment_term_days: int | None = None

    def to_api_payload(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class CreateCustomerInput(BaseModel):
    legal_name: str
    address: AddressInput
    nif: str | None = None
    alternative_id: AlternativeIdInput | None = None
    trade_name: str | None = None
    email: str | None = None
    phone: str | None = None
    billing_emails: list[str] | None = None
    contact_person: str | None = None
    notes: str | None = None
    preferred_payment_method: PaymentInfoInput | None = None
    general_discount: float | None = None

    @model_validator(mode="after")
    def _validate_identifier(self) -> "CreateCustomerInput":
        if not self.nif and not self.alternative_id:
            raise ValueError(
                "Debes informar `nif` o `alternative_id` para crear un cliente."
            )
        if self.nif and self.alternative_id:
            raise ValueError("`nif` y `alternative_id` son mutuamente excluyentes.")
        return self

    def to_api_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "legal_name": self.legal_name,
            "address": self.address.to_api_payload(),
        }
        if self.nif:
            payload["nif"] = self.nif.upper()
        if self.alternative_id:
            payload["alternative_id"] = self.alternative_id.to_api_payload()
        if self.trade_name:
            payload["trade_name"] = self.trade_name
        if self.email:
            payload["email"] = self.email
        if self.phone:
            payload["phone"] = self.phone
        if self.billing_emails:
            payload["billing_emails"] = self.billing_emails
        if self.contact_person:
            payload["contact_person"] = self.contact_person
        if self.notes:
            payload["notes"] = self.notes
        if self.preferred_payment_method:
            payload["preferred_payment_method"] = (
                self.preferred_payment_method.to_api_payload()
            )
        if self.general_discount is not None:
            payload["general_discount"] = self.general_discount
        return payload


class UpdateCustomerInput(BaseModel):
    legal_name: str | None = None
    trade_name: str | None = None
    address: AddressInput | None = None
    phone: str | None = None
    email: str | None = None
    billing_emails: list[str] | None = None
    contact_person: str | None = None
    notes: str | None = None
    preferred_payment_method: PaymentInfoInput | None = None
    general_discount: float | None = None
    active: bool | None = None

    def to_api_payload(self) -> dict[str, Any]:
        payload = self.model_dump(exclude_none=True)
        if self.address:
            payload["address"] = self.address.to_api_payload()
        if self.preferred_payment_method:
            payload["preferred_payment_method"] = (
                self.preferred_payment_method.to_api_payload()
            )
        return payload


class InvoiceLineInput(BaseModel):
    description: str
    quantity: float = 1.0
    unit: str = "units"
    unit_price: float
    discount_percentage: float = 0.0
    tax_type: TaxType = "IVA"
    tax_percentage: float = 21.0
    regime_key: str = "01"
    equivalence_surcharge_rate: float | None = None
    irpf_rate: float | None = None

    def to_api_payload(self) -> dict[str, Any]:
        line: dict[str, Any] = {
            "description": self.description,
            "quantity": self.quantity,
            "unit": self.unit,
            "unit_price": self.unit_price,
            "discount_percentage": self.discount_percentage,
            "main_tax": {
                "type": self.tax_type,
                "percentage": self.tax_percentage,
                "regime_key": self.regime_key,
            },
        }
        if self.equivalence_surcharge_rate is not None:
            line["equivalence_surcharge_rate"] = self.equivalence_surcharge_rate
        if self.irpf_rate is not None:
            line["irpf_rate"] = self.irpf_rate
        return line


class RecipientInput(BaseModel):
    customer_id: str | None = None
    legal_name: str | None = None
    trade_name: str | None = None
    nif: str | None = None
    alternative_id: AlternativeIdInput | None = None
    address: AddressInput | None = None
    phone: str | None = None
    email: str | None = None

    @model_validator(mode="after")
    def _validate_recipient(self) -> "RecipientInput":
        ad_hoc_fields = any(
            [
                self.legal_name,
                self.trade_name,
                self.nif,
                self.alternative_id,
                self.address,
                self.phone,
                self.email,
            ]
        )
        if self.customer_id and ad_hoc_fields:
            raise ValueError(
                "Usa `customer_id` o un `recipient` ad-hoc completo, pero no ambos."
            )
        if not self.customer_id and not self.legal_name:
            raise ValueError(
                "Si no informas `customer_id`, `legal_name` es obligatorio."
            )
        return self

    def to_api_payload(self) -> dict[str, Any]:
        payload = self.model_dump(exclude_none=True)
        if self.alternative_id:
            payload["alternative_id"] = self.alternative_id.to_api_payload()
        if self.address:
            payload["address"] = self.address.to_api_payload()
        return payload


class CreateInvoiceInput(BaseModel):
    type: InvoiceType = "STANDARD"
    recipient: RecipientInput
    lines: list[InvoiceLineInput]
    series_id: str | None = None
    operation_date: str | None = None
    due_date: str | None = None
    payment_info: PaymentInfoInput | None = None
    notes: str | None = None
    rectified_invoice_id: str | None = None
    rectification_reason: str | None = None
    verifactu_enabled: bool = False

    @model_validator(mode="after")
    def _validate_invoice(self) -> "CreateInvoiceInput":
        if not self.lines:
            raise ValueError("La factura debe incluir al menos una linea.")
        if self.type == "CORRECTIVE":
            if not self.rectified_invoice_id or not self.rectification_reason:
                raise ValueError(
                    "Las facturas CORRECTIVE requieren `rectified_invoice_id` y `rectification_reason`."
                )
        if not self.recipient.customer_id and self.type != "SIMPLIFIED":
            if not (self.recipient.nif or self.recipient.alternative_id):
                raise ValueError(
                    "Las facturas no simplificadas con recipient ad-hoc requieren `nif` o `alternative_id`."
                )
            if self.recipient.address is None:
                raise ValueError(
                    "Las facturas no simplificadas con recipient ad-hoc requieren `address`."
                )
        return self

    def to_api_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "type": self.type,
            "recipient": self.recipient.to_api_payload(),
            "lines": [line.to_api_payload() for line in self.lines],
            "options": {
                "issue_directly": False,
                "send_automatically": False,
                "wait_for_pdf": False,
                "verifactu_enabled": self.verifactu_enabled,
            },
        }
        if self.series_id:
            payload["series_id"] = self.series_id
        if self.operation_date:
            payload["operation_date"] = self.operation_date
        if self.due_date:
            payload["due_date"] = self.due_date
        if self.payment_info:
            payload["payment_info"] = self.payment_info.to_api_payload()
        if self.notes:
            payload["notes"] = self.notes
        if self.rectified_invoice_id:
            payload["rectified_invoice_id"] = self.rectified_invoice_id
        if self.rectification_reason:
            payload["rectification_reason"] = self.rectification_reason
        return payload


class UpdateInvoiceInput(BaseModel):
    series_id: str | None = None
    operation_date: str | None = None
    due_date: str | None = None
    recipient: RecipientInput | None = None
    lines: list[InvoiceLineInput] | None = None
    payment_info: PaymentInfoInput | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def _validate_non_empty(self) -> "UpdateInvoiceInput":
        if not any(
            [
                self.series_id,
                self.operation_date is not None,
                self.due_date,
                self.recipient,
                self.lines is not None,
                self.payment_info,
                self.notes is not None,
            ]
        ):
            raise ValueError("Debes informar al menos un campo para actualizar la factura.")
        return self

    def to_api_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if self.series_id:
            payload["series_id"] = self.series_id
        if self.operation_date is not None:
            payload["operation_date"] = self.operation_date
        if self.due_date:
            payload["due_date"] = self.due_date
        if self.recipient:
            payload["recipient"] = self.recipient.to_api_payload()
        if self.lines is not None:
            payload["lines"] = [line.to_api_payload() for line in self.lines]
        if self.payment_info:
            payload["payment_info"] = self.payment_info.to_api_payload()
        if self.notes is not None:
            payload["notes"] = self.notes
        return payload
