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
