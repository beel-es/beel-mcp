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
