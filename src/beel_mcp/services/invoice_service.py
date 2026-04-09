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
