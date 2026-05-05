from __future__ import annotations

from typing import Any

from beel_mcp.config import Settings


def build_auth(settings: Settings) -> Any | None:
    """Construye el `auth` para FastMCP segun el modo configurado.

    - OAUTH_ENABLED=false -> None (modo API Key, stdio).
    - OAUTH_ENABLED=true  -> OAuthProxy contra BeeL.
    """
    if not settings.oauth_enabled:
        return None

    from fastmcp.server.auth import OAuthProxy
    from fastmcp.server.auth.providers.jwt import JWTVerifier
    from fastmcp.server.auth.oauth_proxy.models import ProxyDCRClient

    # BeeL no usa scopes OAuth: ni los registra en su RegisteredClient ni los
    # incluye en el JWT. Hacemos `validate_scope` permisivo en el cliente DCR
    # del MCP para no rechazar scopes que pida un cliente (p. ej. Levante envía
    # `mcp:read mcp:write`). Aun así, los stripeamos antes de llamar a BeeL en
    # `_build_upstream_authorize_url`.
    def _permissive_validate_scope(self, requested_scope):
        if requested_scope is None:
            return None
        return requested_scope.split(" ")

    ProxyDCRClient.validate_scope = _permissive_validate_scope  # type: ignore[method-assign]

    class BeelOAuthProxy(OAuthProxy):
        def _build_upstream_authorize_url(self, txn_id, transaction):
            transaction = {**transaction, "scopes": []}
            return super()._build_upstream_authorize_url(txn_id, transaction)

    token_verifier = JWTVerifier(
        jwks_uri=settings.oauth_jwks_uri,
        issuer=settings.oauth_issuer,
        audience=settings.oauth_audience,
    )

    return BeelOAuthProxy(
        upstream_authorization_endpoint=settings.oauth_authorization_endpoint,
        upstream_token_endpoint=settings.oauth_token_endpoint,
        upstream_client_id=settings.oauth_client_id,
        upstream_client_secret=settings.oauth_client_secret.get_secret_value(),
        token_verifier=token_verifier,
        base_url=settings.mcp_public_url,
    )
