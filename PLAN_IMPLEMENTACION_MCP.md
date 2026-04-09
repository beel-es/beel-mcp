# Runbook de Implementacion — MCP Server de BeeL con FastMCP

> Fecha: 2026-04-06
> Base verificada: `PDR.md` + `beel-api-openapi (2).yaml` (OpenAPI BeeL 1.0.1) + FastMCP v3
> Estado del documento: listo para implementarse

## 1. Objetivo y alcance

Este documento sustituye al plan anterior y deja un runbook autocontenido, coherente y listo para ejecutar. Todo lo que se vaya a implementar aparece aqui con codigo completo.

El alcance del MVP es:

- 14 tools atomicas:
  - `search_customers`
  - `create_customer`
  - `upsert_customer`
  - `validate_nif`
  - `create_invoice_draft`
  - `update_invoice_draft`
  - `issue_invoice`
  - `preview_invoice_pdf`
  - `get_invoice_pdf_download`
  - `send_invoice_email`
  - `mark_invoice_paid`
  - `get_invoice_status`
  - `get_verifactu_status`
  - `export_invoices_excel`
- 3 tools compuestas:
  - `ensure_customer_ready_for_invoicing`
  - `issue_send_and_track_invoice`
  - `follow_up_unpaid_invoices`

## 2. Decisiones de diseno que corrigen el plan anterior

Estas decisiones son obligatorias. Si no se siguen, el servidor no quedara listo.

1. La configuracion no se instancia en import-time.
   Se expone `get_settings()` con cache para no romper tests ni el arranque del servidor.

2. Los servicios no se comparten mediante globales importadas.
   FastMCP inicializa cliente y servicios en `lifespan`, y las tools los obtienen desde `ctx.lifespan_context`.

3. Las tools devuelven `dict`, no JSON string serializado.
   FastMCP serializa la respuesta; no hay que hacer `json.dumps()`.

4. Los guardrails se aplican de verdad antes de mutar estado.
   Se valida confirmacion y estado actual antes de llamar a BeeL.

5. La idempotencia se mantiene estable en reintentos.
   Un mismo `Idempotency-Key` se reutiliza durante todos los retries del mismo request.

6. Se implementa retry con backoff para errores de red, `429` y `5xx`.

7. Los binarios se controlan explicitamente.
   El servidor inlinea PDF/Excel en base64 solo hasta un limite configurable. Si el binario es demasiado grande, la tool devuelve metadatos y obliga a estrechar el filtro.

8. `upsert_customer` hace lo que promete.
   Busca y opcionalmente actualiza; nunca crea. Si hay multiples coincidencias, devuelve estado `customer_ambiguous`.

9. `create_invoice_draft` soporta dos modos correctos:
   - `customer_id`
   - `recipient` ad-hoc completo

10. `mark_invoice_paid` se implementa de forma conservadora.
    La OpenAPI del endpoint individual documenta `SENT -> PAID`; este MCP no asumira transiciones mas amplias en la tool atomica hasta verificarlas externamente.

## 3. Estructura final del proyecto

```text
beel-mcp/
├── pyproject.toml
├── fastmcp.json
├── .env.example
├── src/
│   └── beel_mcp/
│       ├── __init__.py
│       ├── config.py
│       ├── schemas.py
│       ├── runtime.py
│       ├── server.py
│       ├── client/
│       │   ├── __init__.py
│       │   ├── beel_client.py
│       │   ├── exceptions.py
│       │   └── idempotency.py
│       ├── services/
│       │   ├── __init__.py
│       │   ├── customer_service.py
│       │   ├── nif_service.py
│       │   ├── invoice_service.py
│       │   ├── pdf_service.py
│       │   ├── delivery_service.py
│       │   ├── verifactu_service.py
│       │   └── export_service.py
│       ├── policies/
│       │   ├── __init__.py
│       │   ├── confirmations.py
│       │   ├── nif_policy.py
│       │   └── state_machine.py
│       └── tools/
│           ├── __init__.py
│           ├── customer_tools.py
│           ├── nif_tools.py
│           ├── invoice_tools.py
│           ├── pdf_tools.py
│           ├── delivery_tools.py
│           ├── payment_tools.py
│           ├── status_tools.py
│           ├── export_tools.py
│           └── workflow_tools.py
└── tests/
    ├── conftest.py
    ├── test_client.py
    ├── test_customer_service.py
    └── test_policies.py
```

## 4. Archivos a crear

### 4.1 `pyproject.toml`

```toml
[project]
name = "beel-mcp"
version = "0.1.0"
description = "MCP Server para BeeL con tools atomicas y workflows de facturacion"
requires-python = ">=3.11"
dependencies = [
  "fastmcp>=3.2.0",
  "httpx>=0.27.0",
  "pydantic>=2.7.0",
  "pydantic-settings>=2.2.1",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0.0",
  "pytest-asyncio>=0.23.0",
  "respx>=0.21.1",
  "ruff>=0.5.0",
]

[project.scripts]
beel-mcp = "beel_mcp.server:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/beel_mcp"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

### 4.2 `fastmcp.json`

```json
{
  "$schema": "https://gofastmcp.com/public/schemas/fastmcp.json/v1.json",
  "source": {
    "type": "filesystem",
    "path": "src/beel_mcp/server.py:mcp"
  },
  "environment": {
    "type": "uv",
    "python": ">=3.11",
    "dependencies": [
      "fastmcp>=3.2.0",
      "httpx>=0.27.0",
      "pydantic>=2.7.0",
      "pydantic-settings>=2.2.1"
    ]
  },
  "deployment": {
    "transport": "stdio",
    "log_level": "INFO"
  }
}
```

### 4.3 `.env.example`

```env
BEEL_API_KEY=beel_sk_test_xxxxxxxxxxxxxxxxxxxx
BEEL_BASE_URL=https://app.beel.es/api
BEEL_ENVIRONMENT=sandbox
BEEL_TIMEOUT_SECONDS=30
BEEL_MAX_RETRIES=3
BEEL_RETRY_BACKOFF_SECONDS=0.5
BEEL_MAX_INLINE_BINARY_BYTES=1500000
```

### 4.4 `src/beel_mcp/__init__.py`

```python
"""BeeL MCP Server."""
```

### 4.5 `src/beel_mcp/config.py`

```python
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuracion del servidor MCP.

    BeeL usa la misma base URL para sandbox y production. La diferencia real
    viene dada por el prefijo de la API key (`beel_sk_test_` vs `beel_sk_live_`).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    beel_api_key: SecretStr = Field(alias="BEEL_API_KEY")
    beel_base_url: str = Field(
        default="https://app.beel.es/api",
        alias="BEEL_BASE_URL",
    )
    beel_environment: Literal["sandbox", "production"] = Field(
        default="sandbox",
        alias="BEEL_ENVIRONMENT",
    )
    beel_timeout_seconds: float = Field(
        default=30.0,
        alias="BEEL_TIMEOUT_SECONDS",
        ge=1,
        le=120,
    )
    beel_max_retries: int = Field(
        default=3,
        alias="BEEL_MAX_RETRIES",
        ge=0,
        le=5,
    )
    beel_retry_backoff_seconds: float = Field(
        default=0.5,
        alias="BEEL_RETRY_BACKOFF_SECONDS",
        ge=0.1,
        le=10.0,
    )
    beel_max_inline_binary_bytes: int = Field(
        default=1_500_000,
        alias="BEEL_MAX_INLINE_BINARY_BYTES",
        ge=50_000,
        le=10_000_000,
    )

    @field_validator("beel_base_url")
    @classmethod
    def _normalize_base_url(cls, value: str) -> str:
        return value.rstrip("/")

    @property
    def authorization_header(self) -> str:
        return f"Bearer {self.beel_api_key.get_secret_value()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

### 4.6 `src/beel_mcp/schemas.py`

```python
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
```

### 4.7 `src/beel_mcp/runtime.py`

```python
from __future__ import annotations

import base64
import hashlib
from typing import Any

from fastmcp import Context

from beel_mcp.config import Settings
from beel_mcp.schemas import ToolResponse


def get_from_lifespan(ctx: Context | None, key: str) -> Any:
    if ctx is None:
        raise RuntimeError("FastMCP no inyecto Context en la tool.")
    value = ctx.lifespan_context.get(key)
    if value is None:
        raise RuntimeError(
            f"No se encontro `{key}` en lifespan_context. Revisa server.py."
        )
    return value


def get_settings_from_ctx(ctx: Context | None) -> Settings:
    return get_from_lifespan(ctx, "settings")


def success_response(
    *,
    action_taken: str,
    human_summary: str,
    resource_ids: dict[str, str] | None = None,
    data: Any | None = None,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    return ToolResponse(
        success=True,
        action_taken=action_taken,
        human_summary=human_summary,
        resource_ids=resource_ids or {},
        data=data,
        next_recommended_actions=next_actions or [],
    ).model_dump(mode="json")


def error_response(
    *,
    action_taken: str,
    human_summary: str,
    error: str,
    data: Any | None = None,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    return ToolResponse(
        success=False,
        action_taken=action_taken,
        human_summary=human_summary,
        error=error,
        data=data,
        next_recommended_actions=next_actions or [],
    ).model_dump(mode="json")


def confirmation_required_response(
    *,
    action: str,
    message: str,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    return ToolResponse(
        success=False,
        action_taken="confirmation_required",
        human_summary=message,
        data={"action": action},
        next_recommended_actions=next_actions or [],
    ).model_dump(mode="json")


def inline_binary_result(
    data: bytes,
    *,
    file_name: str,
    mime_type: str,
    settings: Settings,
) -> dict[str, Any]:
    size_bytes = len(data)
    digest = hashlib.sha256(data).hexdigest()
    inline_available = size_bytes <= settings.beel_max_inline_binary_bytes

    result: dict[str, Any] = {
        "file_name": file_name,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "sha256": digest,
        "inline_available": inline_available,
    }
    if inline_available:
        result["content_base64"] = base64.b64encode(data).decode("ascii")
    else:
        result["content_base64"] = None
    return result
```

### 4.8 `src/beel_mcp/client/__init__.py`

```python
from beel_mcp.client.beel_client import BeelClient

__all__ = ["BeelClient"]
```

### 4.9 `src/beel_mcp/client/exceptions.py`

```python
from __future__ import annotations

from typing import Any


class BeelApiError(Exception):
    def __init__(
        self,
        *,
        status_code: int | None,
        code: str,
        message: str,
        details: Any | None = None,
        request_id: str | None = None,
        retryable: bool = False,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.request_id = request_id
        self.retryable = retryable
        super().__init__(self.__str__())

    def __str__(self) -> str:
        base = f"{self.code}: {self.message}"
        if self.status_code is not None:
            base = f"[{self.status_code}] {base}"
        if self.request_id:
            base = f"{base} (request_id={self.request_id})"
        return base


class BeelBadRequestError(BeelApiError):
    pass


class BeelUnauthorizedError(BeelApiError):
    pass


class BeelForbiddenError(BeelApiError):
    pass


class BeelNotFoundError(BeelApiError):
    pass


class BeelConflictError(BeelApiError):
    pass


class BeelValidationError(BeelApiError):
    pass


class BeelRateLimitError(BeelApiError):
    pass


class BeelServerError(BeelApiError):
    pass


class BeelTransportError(BeelApiError):
    pass
```

### 4.10 `src/beel_mcp/client/idempotency.py`

```python
from __future__ import annotations

import uuid


def generate_idempotency_key() -> str:
    return str(uuid.uuid4())
```

### 4.11 `src/beel_mcp/client/beel_client.py`

```python
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from beel_mcp.client.exceptions import (
    BeelApiError,
    BeelBadRequestError,
    BeelConflictError,
    BeelForbiddenError,
    BeelNotFoundError,
    BeelRateLimitError,
    BeelServerError,
    BeelTransportError,
    BeelUnauthorizedError,
    BeelValidationError,
)
from beel_mcp.client.idempotency import generate_idempotency_key
from beel_mcp.config import Settings


class BeelClient:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.beel_base_url,
            timeout=httpx.Timeout(settings.beel_timeout_seconds),
            headers={
                "Authorization": settings.authorization_header,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    def _build_error_from_response(self, response: httpx.Response) -> BeelApiError:
        try:
            payload = response.json()
        except ValueError:
            payload = {}

        error = payload.get("error") or {}
        meta = payload.get("meta") or {}

        code = error.get("code") or "HTTP_ERROR"
        message = error.get("message") or response.text or response.reason_phrase
        details = error.get("details")
        request_id = meta.get("request_id")
        retryable = response.status_code == 429 or response.status_code >= 500

        mapping: dict[int, type[BeelApiError]] = {
            400: BeelBadRequestError,
            401: BeelUnauthorizedError,
            403: BeelForbiddenError,
            404: BeelNotFoundError,
            409: BeelConflictError,
            422: BeelValidationError,
            429: BeelRateLimitError,
        }
        exc_class = mapping.get(response.status_code, BeelServerError)
        return exc_class(
            status_code=response.status_code,
            code=code,
            message=message,
            details=details,
            request_id=request_id,
            retryable=retryable,
        )

    def _retry_delay(self, attempt: int, response: httpx.Response | None = None) -> float:
        if response is not None:
            retry_after = response.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                return float(retry_after)
        return self._settings.beel_retry_backoff_seconds * (2 ** attempt)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
        idempotent: bool = False,
        expect_bytes: bool = False,
        idempotency_key: str | None = None,
    ) -> Any:
        headers = dict(extra_headers or {})
        stable_idempotency_key = idempotency_key
        if idempotent:
            stable_idempotency_key = stable_idempotency_key or generate_idempotency_key()
            headers["Idempotency-Key"] = stable_idempotency_key

        max_attempts = self._settings.beel_max_retries + 1
        last_error: Exception | None = None

        for attempt in range(max_attempts):
            try:
                response = await self._client.request(
                    method=method,
                    url=path,
                    params=params,
                    json=json_body,
                    headers=headers,
                )

                if response.status_code == 204:
                    return {}

                if response.status_code == 429 or response.status_code >= 500:
                    error = self._build_error_from_response(response)
                    if attempt < max_attempts - 1:
                        await asyncio.sleep(self._retry_delay(attempt, response))
                        continue
                    raise error

                if response.is_error:
                    raise self._build_error_from_response(response)

                if expect_bytes:
                    return response.content
                return response.json()
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = exc
                if attempt < max_attempts - 1:
                    await asyncio.sleep(self._retry_delay(attempt))
                    continue
                raise BeelTransportError(
                    status_code=None,
                    code="TRANSPORT_ERROR",
                    message=str(exc),
                    retryable=True,
                ) from exc

        raise BeelTransportError(
            status_code=None,
            code="TRANSPORT_ERROR",
            message=str(last_error) if last_error else "Unknown transport error",
            retryable=True,
        )

    async def list_customers(self, **params: Any) -> dict[str, Any]:
        return await self._request("GET", "/v1/customers", params=params)

    async def get_customer(self, customer_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v1/customers/{customer_id}")

    async def create_customer(self, data: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/v1/customers",
            json_body=data,
            idempotent=True,
        )

    async def update_customer(self, customer_id: str, data: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "PUT",
            f"/v1/customers/{customer_id}",
            json_body=data,
        )

    async def deactivate_customer(self, customer_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/v1/customers/{customer_id}")

    async def validate_nif(self, nif: str, legal_name: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"nif": nif}
        if legal_name:
            body["legal_name"] = legal_name
        return await self._request("POST", "/v1/nif/validate", json_body=body)

    async def list_invoices(self, **params: Any) -> dict[str, Any]:
        return await self._request("GET", "/v1/invoices", params=params)

    async def get_invoice(self, invoice_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v1/invoices/{invoice_id}")

    async def create_invoice(self, data: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/v1/invoices",
            json_body=data,
            idempotent=True,
        )

    async def update_invoice(self, invoice_id: str, data: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "PUT",
            f"/v1/invoices/{invoice_id}",
            json_body=data,
        )

    async def delete_invoice(self, invoice_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/v1/invoices/{invoice_id}")

    async def issue_invoice(self, invoice_id: str, wait_for_pdf: bool = True) -> dict[str, Any]:
        params = {"wait_for_pdf": str(wait_for_pdf).lower()}
        return await self._request(
            "POST",
            f"/v1/invoices/{invoice_id}/issue",
            params=params,
            json_body={},
        )

    async def get_invoice_pdf_url(self, invoice_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v1/invoices/{invoice_id}/pdf")

    async def preview_invoice_pdf(self, invoice_id: str) -> bytes:
        return await self._request(
            "GET",
            f"/v1/invoices/{invoice_id}/pdf/preview",
            extra_headers={"Accept": "application/pdf"},
            expect_bytes=True,
        )

    async def send_invoice_email(
        self,
        invoice_id: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/v1/invoices/{invoice_id}/send",
            json_body=data or {},
        )

    async def mark_invoice_paid(
        self,
        invoice_id: str,
        payment_date: str | None = None,
        payment_method: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if payment_date:
            body["payment_date"] = payment_date
        if payment_method:
            body["payment_method"] = payment_method
        return await self._request(
            "POST",
            f"/v1/invoices/{invoice_id}/mark-paid",
            json_body=body,
        )

    async def export_invoices_excel(self, data: dict[str, Any]) -> bytes:
        return await self._request(
            "POST",
            "/v1/invoices/export/excel",
            json_body=data,
            expect_bytes=True,
        )
```

### 4.12 `src/beel_mcp/services/__init__.py`

```python
```

### 4.13 `src/beel_mcp/services/customer_service.py`

```python
from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient
from beel_mcp.schemas import CreateCustomerInput, UpdateCustomerInput


class CustomerService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def search(
        self,
        *,
        search: str | None = None,
        nif: str | None = None,
        email: str | None = None,
        legal_name: str | None = None,
        page: int = 1,
        limit: int = 20,
    ) -> dict:
        params: dict[str, object] = {"page": page, "limit": limit}
        if search:
            params["search"] = search
        if nif:
            params["nif"] = nif
        if email:
            params["email"] = email
        if legal_name:
            params["legal_name"] = legal_name
        return await self._client.list_customers(**params)

    async def create(self, data: CreateCustomerInput) -> dict:
        return await self._client.create_customer(data.to_api_payload())

    async def update(self, customer_id: str, data: UpdateCustomerInput) -> dict:
        return await self._client.update_customer(customer_id, data.to_api_payload())

    async def find_or_update(
        self,
        *,
        nif: str | None = None,
        email: str | None = None,
        legal_name: str | None = None,
        update_data: UpdateCustomerInput | None = None,
    ) -> dict:
        if not any([nif, email, legal_name]):
            raise ValueError("Debes informar nif, email o legal_name para buscar cliente.")

        result = await self.search(
            nif=nif,
            email=email,
            legal_name=legal_name,
            limit=10,
        )
        customers = result.get("data", {}).get("customers", [])

        matches = customers
        if nif:
            matches = [c for c in customers if (c.get("nif") or "").upper() == nif.upper()]
        elif email:
            matches = [
                c
                for c in customers
                if (c.get("email") or "").lower() == email.lower()
            ]

        criteria = {"nif": nif, "email": email, "legal_name": legal_name}

        if not matches:
            return {"status": "not_found", "search_criteria": criteria}

        if len(matches) > 1:
            return {
                "status": "ambiguous",
                "search_criteria": criteria,
                "matches": matches[:5],
            }

        customer = matches[0]
        if update_data is None:
            return {"status": "found", "customer": customer, "updated": False}

        payload = update_data.to_api_payload()
        if not payload:
            return {"status": "found", "customer": customer, "updated": False}

        updated = await self._client.update_customer(customer["id"], payload)
        return {
            "status": "updated",
            "customer": updated["data"],
            "updated": True,
        }
```

### 4.14 `src/beel_mcp/services/nif_service.py`

```python
from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient


class NifService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def validate(self, nif: str, legal_name: str | None = None) -> dict:
        return await self._client.validate_nif(nif=nif, legal_name=legal_name)
```

### 4.15 `src/beel_mcp/services/invoice_service.py`

```python
from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient
from beel_mcp.policies.state_machine import assert_action_allowed
from beel_mcp.schemas import CreateInvoiceInput, UpdateInvoiceInput


class InvoiceService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def create_draft(self, data: CreateInvoiceInput) -> dict:
        payload = data.to_api_payload()
        payload["options"]["issue_directly"] = False
        payload["options"]["send_automatically"] = False
        payload["options"]["wait_for_pdf"] = False
        return await self._client.create_invoice(payload)

    async def update_draft(self, invoice_id: str, data: UpdateInvoiceInput) -> dict:
        current = await self.get(invoice_id)
        invoice = current["data"]
        assert_action_allowed("update_invoice_draft", invoice.get("status"))
        return await self._client.update_invoice(invoice_id, data.to_api_payload())

    async def issue(self, invoice_id: str, wait_for_pdf: bool = True) -> dict:
        current = await self.get(invoice_id)
        invoice = current["data"]
        assert_action_allowed("issue_invoice", invoice.get("status"))
        return await self._client.issue_invoice(invoice_id, wait_for_pdf=wait_for_pdf)

    async def get(self, invoice_id: str) -> dict:
        return await self._client.get_invoice(invoice_id)

    async def list_invoices(self, **params: object) -> dict:
        return await self._client.list_invoices(**params)

    async def ensure_action_allowed(self, invoice_id: str, action: str) -> dict:
        result = await self.get(invoice_id)
        invoice = result["data"]
        assert_action_allowed(action, invoice.get("status"))
        return invoice

    async def mark_paid(
        self,
        invoice_id: str,
        *,
        payment_date: str | None = None,
        payment_method: dict | None = None,
    ) -> dict:
        await self.ensure_action_allowed(invoice_id, "mark_invoice_paid")
        return await self._client.mark_invoice_paid(
            invoice_id=invoice_id,
            payment_date=payment_date,
            payment_method=payment_method,
        )
```

### 4.16 `src/beel_mcp/services/pdf_service.py`

```python
from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient


class PdfService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def get_download_url(self, invoice_id: str) -> dict:
        return await self._client.get_invoice_pdf_url(invoice_id)

    async def preview_draft(self, invoice_id: str) -> bytes:
        return await self._client.preview_invoice_pdf(invoice_id)
```

### 4.17 `src/beel_mcp/services/delivery_service.py`

```python
from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient


class DeliveryService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def send_email(
        self,
        invoice_id: str,
        *,
        recipients: list[str] | None = None,
        cc: list[str] | None = None,
        subject: str | None = None,
        message: str | None = None,
        attach_pdf: bool = True,
        language: str | None = None,
    ) -> dict:
        body: dict[str, object] = {"attach_pdf": attach_pdf}
        if recipients:
            body["recipients"] = recipients
        if cc:
            body["cc"] = cc
        if subject:
            body["subject"] = subject
        if message:
            body["message"] = message
        if language:
            body["language"] = language
        return await self._client.send_invoice_email(invoice_id, body)
```

### 4.18 `src/beel_mcp/services/verifactu_service.py`

```python
from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient


class VerifactuService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def get_status(self, invoice_id: str) -> dict:
        result = await self._client.get_invoice(invoice_id)
        invoice = result.get("data", {})
        verifactu = invoice.get("verifactu", {})
        return {
            "invoice_id": invoice.get("id"),
            "invoice_number": invoice.get("invoice_number"),
            "invoice_status": invoice.get("status"),
            "verifactu_enabled": verifactu.get("enabled", False),
            "submission_status": verifactu.get("submission_status"),
            "registration_number": verifactu.get("registration_number"),
            "error_code": verifactu.get("error_code"),
            "error_message": verifactu.get("error_message"),
            "qr_url": verifactu.get("qr_url"),
        }
```

### 4.19 `src/beel_mcp/services/export_service.py`

```python
from __future__ import annotations

from typing import Literal

from beel_mcp.client.beel_client import BeelClient


class ExportService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def export_excel(
        self,
        *,
        invoice_ids: list[str] | None = None,
        status: str | None = None,
        invoice_type: Literal["STANDARD", "SIMPLIFIED", "CORRECTIVE"] | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        customer_id: str | None = None,
        format_type: Literal["SUMMARY", "ITEMS"] = "SUMMARY",
    ) -> bytes:
        body: dict[str, object] = {"format": format_type}
        if invoice_ids:
            body["invoice_ids"] = invoice_ids
        else:
            if status:
                body["status"] = status
            if invoice_type:
                body["type"] = invoice_type
            if date_from:
                body["date_from"] = date_from
            if date_to:
                body["date_to"] = date_to
            if customer_id:
                body["customer_id"] = customer_id
        return await self._client.export_invoices_excel(body)
```

### 4.20 `src/beel_mcp/policies/__init__.py`

```python
```

### 4.21 `src/beel_mcp/policies/confirmations.py`

```python
from __future__ import annotations


ACTIONS_REQUIRING_CONFIRMATION: dict[str, str] = {
    "issue_invoice": "Emitir una factura tiene efectos fiscales irreversibles.",
    "send_invoice_email": "Enviar una factura por email es una accion operativa real.",
    "mark_invoice_paid": "Marcar una factura como pagada modifica su estado contable.",
    "export_invoices_excel": "La exportacion puede exponer datos fiscales y personales.",
    "issue_send_and_track_invoice": (
        "Este workflow emite la factura y puede enviarla por email en el mismo paso."
    ),
}


def requires_confirmation(action: str) -> bool:
    return action in ACTIONS_REQUIRING_CONFIRMATION


def get_confirmation_message(action: str) -> str:
    return ACTIONS_REQUIRING_CONFIRMATION[action]
```

### 4.22 `src/beel_mcp/policies/nif_policy.py`

```python
from __future__ import annotations


def evaluate_nif_result(status: str | None) -> dict[str, object]:
    if status == "VALID":
        return {
            "can_proceed": True,
            "warning": None,
            "recommendation": "NIF valido. Se puede continuar.",
        }
    if status == "PENDING":
        return {
            "can_proceed": True,
            "warning": (
                "La API de VeriFactu no estaba disponible; el NIF tiene formato valido "
                "pero no se pudo verificar contra AEAT."
            ),
            "recommendation": "Se puede continuar con precaucion y revalidar mas tarde.",
        }
    if status == "INVALID":
        return {
            "can_proceed": False,
            "warning": "NIF invalido segun AEAT.",
            "recommendation": "Bloquear por defecto y corregir el NIF antes de emitir.",
        }
    return {
        "can_proceed": False,
        "warning": "Error tecnico validando el NIF.",
        "recommendation": "Reintentar validacion antes de continuar.",
    }
```

### 4.23 `src/beel_mcp/policies/state_machine.py`

```python
from __future__ import annotations


class PolicyViolation(ValueError):
    pass


ALLOWED_STATUSES_BY_ACTION: dict[str, set[str]] = {
    "update_invoice_draft": {"DRAFT"},
    "preview_invoice_pdf": {"DRAFT"},
    "issue_invoice": {"DRAFT"},
    "send_invoice_email": {"ISSUED", "SENT", "PAID", "OVERDUE"},
    # Implementacion conservadora: la OpenAPI del endpoint individual
    # documenta SENT -> PAID.
    "mark_invoice_paid": {"SENT"},
}


def is_action_allowed(action: str, current_status: str | None) -> bool:
    allowed = ALLOWED_STATUSES_BY_ACTION.get(action)
    if not allowed:
        return True
    return current_status in allowed


def assert_action_allowed(action: str, current_status: str | None) -> None:
    allowed = ALLOWED_STATUSES_BY_ACTION.get(action)
    if not allowed:
        return
    if current_status not in allowed:
        allowed_display = ", ".join(sorted(allowed))
        raise PolicyViolation(
            f"La accion `{action}` no esta permitida desde el estado `{current_status}`. "
            f"Estados permitidos: {allowed_display}."
        )
```

### 4.24 `src/beel_mcp/tools/__init__.py`

```python
```

### 4.25 `src/beel_mcp/tools/customer_tools.py`

```python
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
```

### 4.26 `src/beel_mcp/tools/nif_tools.py`

```python
from __future__ import annotations

from fastmcp import Context

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.policies.nif_policy import evaluate_nif_result
from beel_mcp.runtime import error_response, get_from_lifespan, success_response


async def validate_nif(
    nif: str,
    legal_name: str | None = None,
    ctx: Context | None = None,
) -> dict:
    """Valida un NIF/CIF contra AEAT a traves del endpoint publico de BeeL."""
    nif_svc = get_from_lifespan(ctx, "nif_service")
    try:
        result = await nif_svc.validate(nif=nif.upper(), legal_name=legal_name)
        nif_data = result.get("data", {})
        status = nif_data.get("status")
        policy = evaluate_nif_result(status)
        return success_response(
            action_taken="nif_validated",
            human_summary=f"NIF {nif.upper()}: estado {status}. {policy['recommendation']}",
            data={
                "nif": nif.upper(),
                "valid": nif_data.get("valid"),
                "status": status,
                "legal_name_from_aeat": nif_data.get("legal_name"),
                "validated_at": nif_data.get("validated_at"),
                "can_proceed": policy["can_proceed"],
                "warning": policy["warning"],
            },
            next_actions=["create_customer", "create_invoice_draft"]
            if policy["can_proceed"]
            else ["corregir_nif"],
        )
    except BeelApiError as exc:
        return error_response(
            action_taken="nif_validation_failed",
            human_summary=f"Error validando NIF: {exc.message}",
            error=str(exc),
        )
```

### 4.27 `src/beel_mcp/tools/invoice_tools.py`

```python
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
```

### 4.28 `src/beel_mcp/tools/pdf_tools.py`

```python
from __future__ import annotations

from fastmcp import Context

from beel_mcp.client.exceptions import BeelApiError
from beel_mcp.runtime import (
    error_response,
    get_from_lifespan,
    get_settings_from_ctx,
    inline_binary_result,
    success_response,
)


async def preview_invoice_pdf(
    invoice_id: str,
    ctx: Context | None = None,
) -> dict:
    """Genera el PDF de previsualizacion de una factura en borrador."""
    invoice_svc = get_from_lifespan(ctx, "invoice_service")
    pdf_svc = get_from_lifespan(ctx, "pdf_service")
    settings = get_settings_from_ctx(ctx)
    try:
        await invoice_svc.ensure_action_allowed(invoice_id, "preview_invoice_pdf")
        pdf_bytes = await pdf_svc.preview_draft(invoice_id)
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
```

### 4.29 `src/beel_mcp/tools/delivery_tools.py`

```python
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
            next_actions=["get_invoice_status"],
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
            next_actions=["get_invoice_status", "mark_invoice_paid"],
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
```

### 4.30 `src/beel_mcp/tools/payment_tools.py`

```python
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
```

### 4.31 `src/beel_mcp/tools/status_tools.py`

```python
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
```

### 4.32 `src/beel_mcp/tools/export_tools.py`

```python
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
```

### 4.33 `src/beel_mcp/tools/workflow_tools.py`

```python
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
```

### 4.34 `src/beel_mcp/server.py`

```python
from __future__ import annotations

from contextlib import asynccontextmanager

from fastmcp import FastMCP

from beel_mcp.client.beel_client import BeelClient
from beel_mcp.config import get_settings
from beel_mcp.services.customer_service import CustomerService
from beel_mcp.services.delivery_service import DeliveryService
from beel_mcp.services.export_service import ExportService
from beel_mcp.services.invoice_service import InvoiceService
from beel_mcp.services.nif_service import NifService
from beel_mcp.services.pdf_service import PdfService
from beel_mcp.services.verifactu_service import VerifactuService


@asynccontextmanager
async def lifespan(_: FastMCP):
    settings = get_settings()
    beel_client = BeelClient(settings)
    try:
        yield {
            "settings": settings,
            "beel_client": beel_client,
            "customer_service": CustomerService(beel_client),
            "nif_service": NifService(beel_client),
            "invoice_service": InvoiceService(beel_client),
            "pdf_service": PdfService(beel_client),
            "delivery_service": DeliveryService(beel_client),
            "verifactu_service": VerifactuService(beel_client),
            "export_service": ExportService(beel_client),
        }
    finally:
        await beel_client.close()


mcp = FastMCP(
    name="BeeL MCP Server",
    instructions=(
        "Servidor MCP para operar BeeL con guardrails fiscales. "
        "Permite buscar y crear clientes, validar NIF, crear y emitir facturas, "
        "consultar VeriFactu, enviar por email y exportar datos."
    ),
    lifespan=lifespan,
)


from beel_mcp.tools.customer_tools import (  # noqa: E402
    create_customer,
    search_customers,
    upsert_customer,
)
from beel_mcp.tools.delivery_tools import send_invoice_email  # noqa: E402
from beel_mcp.tools.export_tools import export_invoices_excel  # noqa: E402
from beel_mcp.tools.invoice_tools import (  # noqa: E402
    create_invoice_draft,
    issue_invoice,
    update_invoice_draft,
)
from beel_mcp.tools.nif_tools import validate_nif  # noqa: E402
from beel_mcp.tools.payment_tools import mark_invoice_paid  # noqa: E402
from beel_mcp.tools.pdf_tools import (  # noqa: E402
    get_invoice_pdf_download,
    preview_invoice_pdf,
)
from beel_mcp.tools.status_tools import (  # noqa: E402
    get_invoice_status,
    get_verifactu_status,
)
from beel_mcp.tools.workflow_tools import (  # noqa: E402
    ensure_customer_ready_for_invoicing,
    follow_up_unpaid_invoices,
    issue_send_and_track_invoice,
)


mcp.tool(search_customers)
mcp.tool(create_customer)
mcp.tool(upsert_customer)
mcp.tool(validate_nif)
mcp.tool(create_invoice_draft)
mcp.tool(update_invoice_draft)
mcp.tool(issue_invoice)
mcp.tool(preview_invoice_pdf)
mcp.tool(get_invoice_pdf_download)
mcp.tool(send_invoice_email)
mcp.tool(mark_invoice_paid)
mcp.tool(get_invoice_status)
mcp.tool(get_verifactu_status)
mcp.tool(export_invoices_excel)
mcp.tool(ensure_customer_ready_for_invoicing)
mcp.tool(issue_send_and_track_invoice)
mcp.tool(follow_up_unpaid_invoices)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
```

### 4.35 `tests/conftest.py`

```python
from __future__ import annotations

import pytest

from beel_mcp.config import Settings


@pytest.fixture
def mock_settings() -> Settings:
    return Settings(
        BEEL_API_KEY="beel_sk_test_fake",
        BEEL_BASE_URL="https://app.beel.es/api",
        BEEL_ENVIRONMENT="sandbox",
        BEEL_TIMEOUT_SECONDS=5,
        BEEL_MAX_RETRIES=1,
        BEEL_RETRY_BACKOFF_SECONDS=0.01,
        BEEL_MAX_INLINE_BINARY_BYTES=100_000,
    )
```

### 4.36 `tests/test_client.py`

```python
from __future__ import annotations

import httpx
import pytest

from beel_mcp.client.beel_client import BeelClient


@pytest.mark.asyncio
async def test_create_invoice_reuses_same_idempotency_key_on_retry(mock_settings):
    seen_keys: list[str | None] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen_keys.append(request.headers.get("Idempotency-Key"))
        if len(seen_keys) == 1:
            return httpx.Response(
                500,
                json={
                    "success": False,
                    "error": {"code": "INTERNAL_ERROR", "message": "boom"},
                },
            )
        return httpx.Response(
            201,
            json={"success": True, "data": {"id": "invoice-1"}},
        )

    client = BeelClient(mock_settings, transport=httpx.MockTransport(handler))
    try:
        result = await client.create_invoice(
            {
                "type": "STANDARD",
                "recipient": {"customer_id": "customer-1"},
                "lines": [
                    {
                        "description": "Consultoria",
                        "quantity": 1,
                        "unit_price": 100,
                    }
                ],
            }
        )
        assert result["data"]["id"] == "invoice-1"
        assert len(seen_keys) == 2
        assert seen_keys[0] == seen_keys[1]
        assert seen_keys[0] is not None
    finally:
        await client.close()
```

### 4.37 `tests/test_customer_service.py`

```python
from __future__ import annotations

import pytest

from beel_mcp.schemas import UpdateCustomerInput
from beel_mcp.services.customer_service import CustomerService


class DummyClient:
    def __init__(self) -> None:
        self.updated_customer_id: str | None = None

    async def list_customers(self, **params):
        if params.get("nif") == "B11111111":
            return {
                "data": {
                    "customers": [
                        {"id": "c1", "legal_name": "Cliente Uno", "nif": "B11111111"}
                    ]
                }
            }
        if params.get("legal_name") == "Duplicado":
            return {
                "data": {
                    "customers": [
                        {"id": "c1", "legal_name": "Duplicado"},
                        {"id": "c2", "legal_name": "Duplicado"},
                    ]
                }
            }
        return {"data": {"customers": []}}

    async def update_customer(self, customer_id, data):
        self.updated_customer_id = customer_id
        return {"data": {"id": customer_id, **data}}


@pytest.mark.asyncio
async def test_find_or_update_returns_not_found():
    service = CustomerService(DummyClient())
    result = await service.find_or_update(nif="B99999999")
    assert result["status"] == "not_found"


@pytest.mark.asyncio
async def test_find_or_update_returns_ambiguous():
    service = CustomerService(DummyClient())
    result = await service.find_or_update(legal_name="Duplicado")
    assert result["status"] == "ambiguous"


@pytest.mark.asyncio
async def test_find_or_update_updates_exact_match():
    client = DummyClient()
    service = CustomerService(client)
    result = await service.find_or_update(
        nif="B11111111",
        update_data=UpdateCustomerInput(notes="actualizado"),
    )
    assert result["status"] == "updated"
    assert client.updated_customer_id == "c1"
```

### 4.38 `tests/test_policies.py`

```python
from __future__ import annotations

import pytest

from beel_mcp.policies.nif_policy import evaluate_nif_result
from beel_mcp.policies.state_machine import PolicyViolation, assert_action_allowed


def test_nif_policy_pending_can_proceed():
    policy = evaluate_nif_result("PENDING")
    assert policy["can_proceed"] is True


def test_issue_invoice_requires_draft():
    with pytest.raises(PolicyViolation):
        assert_action_allowed("issue_invoice", "SENT")


def test_mark_paid_requires_sent():
    with pytest.raises(PolicyViolation):
        assert_action_allowed("mark_invoice_paid", "ISSUED")
```

## 5. Orden de implementacion

Aplica este runbook en este orden:

1. Crear `pyproject.toml`, `fastmcp.json` y `.env.example`.
2. Crear `config.py`, `schemas.py`, `runtime.py`.
3. Crear `client/`.
4. Crear `services/`.
5. Crear `policies/`.
6. Crear `tools/`.
7. Crear `server.py`.
8. Crear `tests/`.
9. Instalar dependencias y ejecutar tests.

## 6. Comandos de instalacion y ejecucion

### 6.1 Instalar

```bash
uv sync --extra dev
cp .env.example .env
```

### 6.2 Ejecutar en desarrollo

```bash
uv run python -m beel_mcp.server
```

o:

```bash
uv run fastmcp run src/beel_mcp/server.py:mcp
```

### 6.3 Instalar en clientes MCP

```bash
uv run fastmcp install claude-desktop src/beel_mcp/server.py:mcp \
  --server-name "BeeL Facturacion" \
  --env-file .env
```

```bash
uv run fastmcp install claude-code src/beel_mcp/server.py:mcp \
  --server-name "BeeL Facturacion" \
  --env-file .env
```

```bash
uv run fastmcp install cursor src/beel_mcp/server.py:mcp \
  --server-name "BeeL Facturacion" \
  --env-file .env
```

## 7. Verificacion minima obligatoria

Antes de considerar terminado el trabajo, deben pasar estos checks:

1. `uv run pytest -q`
2. `uv run ruff check .`
3. El servidor arranca sin importar `.env` en import-time.
4. Las 17 tools aparecen registradas.
5. `issue_invoice` y `mark_invoice_paid` bloquean por estado invalido antes de llamar a BeeL.
6. Los retries reutilizan el mismo `Idempotency-Key`.
7. `workflow_tools` esta importado y registrado en `server.py`.

## 8. Checklist de aceptacion funcional

- `search_customers` busca por `query`, `nif`, `email` y `legal_name`.
- `create_customer` soporta `nif` o `alternative_id`.
- `upsert_customer` devuelve `customer_not_found`, `customer_ambiguous`, `customer_found` o `customer_updated`.
- `validate_nif` aplica politica `VALID / INVALID / PENDING / ERROR`.
- `create_invoice_draft` exige `customer_id` o `recipient`.
- `update_invoice_draft` solo opera sobre `DRAFT`.
- `issue_invoice` exige `confirm=true`.
- `preview_invoice_pdf` solo opera sobre `DRAFT`.
- `send_invoice_email` exige `confirm=true`.
- `mark_invoice_paid` exige `confirm=true` y estado `SENT`.
- `get_verifactu_status` resume `PENDING / ACCEPTED / REJECTED / no habilitado`.
- `export_invoices_excel` inlinea binario solo hasta el limite configurado.
- `issue_send_and_track_invoice` informa pasos completados si falla a mitad.

## 9. Lo que queda explicitamente fuera de este MVP

No se implementa en este runbook:

- webhooks de BeeL
- recurring invoices
- products
- series management
- company profiles via `X-Active-Profile`
- tools de anulacion, duplicado o facturas correctivas dedicadas

Si se quieren implementar mas adelante, deben aparecer con codigo completo en una nueva version del runbook.
