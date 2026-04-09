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
