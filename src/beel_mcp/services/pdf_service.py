from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient


class PdfService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def get_download_url(self, invoice_id: str) -> dict:
        return await self._client.get_invoice_pdf_url(invoice_id)

    async def preview_draft(self, invoice_id: str) -> bytes:
        return await self._client.preview_invoice_pdf(invoice_id)
