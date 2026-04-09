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
