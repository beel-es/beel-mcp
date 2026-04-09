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
