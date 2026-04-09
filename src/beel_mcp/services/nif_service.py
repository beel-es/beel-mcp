from __future__ import annotations

from beel_mcp.client.beel_client import BeelClient


class NifService:
    def __init__(self, client: BeelClient) -> None:
        self._client = client

    async def validate(self, nif: str, legal_name: str | None = None) -> dict:
        return await self._client.validate_nif(nif=nif, legal_name=legal_name)
