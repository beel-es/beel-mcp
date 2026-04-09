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
