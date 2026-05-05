from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

_log = logging.getLogger("beel_mcp.beel_client")

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
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if settings.authorization_header:
            headers["Authorization"] = settings.authorization_header
        self._client = httpx.AsyncClient(
            base_url=settings.beel_base_url,
            timeout=httpx.Timeout(settings.beel_timeout_seconds),
            headers=headers,
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
                req = self._client.build_request(
                    method=method,
                    url=path,
                    params=params,
                    json=json_body,
                    headers=headers,
                )
                _log.warning(
                    "[BeeL HTTP] %s %s (auth=%s)",
                    req.method,
                    req.url,
                    "Bearer ***" + (req.headers.get("authorization", "") or "")[-12:],
                )
                response = await self._client.send(req)

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
