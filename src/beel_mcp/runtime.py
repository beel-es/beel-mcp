from __future__ import annotations

import base64
import hashlib
from typing import Any

from fastmcp import Context
from fastmcp.server.dependencies import get_http_request

from beel_mcp.config import Settings
from beel_mcp.schemas import ToolResponse

def _debug_log_jwt_claims(token: str) -> None:
    """TEMP: imprime el JWT crudo + claims para debug 403 de BeeL."""
    import json
    import logging

    log = logging.getLogger("beel_mcp.debug")
    log.warning("[BeeL JWT raw] %s", token)
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        log.warning(
            "[BeeL JWT claims forwarded] %s",
            json.dumps(payload, default=str, sort_keys=True),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("[BeeL JWT claims forwarded] no decodificable: %s", e)


_SERVICE_NAMES = {
    "customer_service",
    "nif_service",
    "invoice_service",
    "pdf_service",
    "delivery_service",
    "verifactu_service",
    "export_service",
}


def resolve_api_key(ctx: Context) -> str:
    """Resuelve el credencial a enviar en Authorization: Bearer a la API de BeeL.

    Prioridad:
    1. OAuth activado -> access token validado por FastMCP.
    2. Header HTTP `Authorization: Bearer ...` (modo multi-tenant HTTP).
    3. settings.beel_api_key (modo stdio / desarrollo).
    """
    settings = ctx.lifespan_context.get("settings")

    if settings and settings.oauth_enabled:
        try:
            from fastmcp.server.dependencies import get_access_token

            token = get_access_token()
            if token is not None and token.token:
                _debug_log_jwt_claims(token.token)
                return token.token
        except RuntimeError:
            pass
        raise RuntimeError(
            "OAuth activado pero no se encontro access token en la request."
        )

    try:
        request = get_http_request()
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
    except RuntimeError:
        pass  # No HTTP request (stdio mode)

    if settings and settings.beel_api_key:
        return settings.beel_api_key.get_secret_value()

    raise RuntimeError(
        "No se encontro credencial. Configura BEEL_API_KEY (.env), "
        "manda `Authorization: Bearer <key>` en HTTP, o activa OAUTH_ENABLED."
    )


def _resolve_service_for_request(ctx: Context, service_name: str) -> Any:
    api_key = resolve_api_key(ctx)
    settings: Settings = ctx.lifespan_context["settings"]

    # Fast path: if the key matches the lifespan default, return existing service
    default_key = (
        settings.beel_api_key.get_secret_value() if settings.beel_api_key else None
    )
    if api_key == default_key:
        return ctx.lifespan_context[service_name]

    # Slow path: create/get services for this API key
    client_cache: dict = ctx.lifespan_context["client_cache"]
    if api_key not in client_cache:
        from pydantic import SecretStr

        from beel_mcp.client.beel_client import BeelClient
        from beel_mcp.services.customer_service import CustomerService
        from beel_mcp.services.delivery_service import DeliveryService
        from beel_mcp.services.export_service import ExportService
        from beel_mcp.services.invoice_service import InvoiceService
        from beel_mcp.services.nif_service import NifService
        from beel_mcp.services.pdf_service import PdfService
        from beel_mcp.services.verifactu_service import VerifactuService

        user_settings = settings.model_copy(
            update={"beel_api_key": SecretStr(api_key)}
        )
        client = BeelClient(user_settings)
        client_cache[api_key] = {
            "beel_client": client,
            "customer_service": CustomerService(client),
            "nif_service": NifService(client),
            "invoice_service": InvoiceService(client),
            "pdf_service": PdfService(client),
            "delivery_service": DeliveryService(client),
            "verifactu_service": VerifactuService(client),
            "export_service": ExportService(client),
        }

    return client_cache[api_key][service_name]


def get_from_lifespan(ctx: Context | None, key: str) -> Any:
    if ctx is None:
        raise RuntimeError("FastMCP no inyecto Context en la tool.")

    if key in _SERVICE_NAMES:
        return _resolve_service_for_request(ctx, key)

    value = ctx.lifespan_context.get(key)
    if value is None:
        raise RuntimeError(
            f"No se encontro `{key}` en lifespan_context. Revisa server.py."
        )
    return value


def get_settings_from_ctx(ctx: Context | None) -> Settings:
    return get_from_lifespan(ctx, "settings")


def success_response(
    *,
    action_taken: str,
    human_summary: str,
    resource_ids: dict[str, str] | None = None,
    data: Any | None = None,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    return ToolResponse(
        success=True,
        action_taken=action_taken,
        human_summary=human_summary,
        resource_ids=resource_ids or {},
        data=data,
        next_recommended_actions=next_actions or [],
    ).model_dump(mode="json")


def error_response(
    *,
    action_taken: str,
    human_summary: str,
    error: str,
    data: Any | None = None,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    return ToolResponse(
        success=False,
        action_taken=action_taken,
        human_summary=human_summary,
        error=error,
        data=data,
        next_recommended_actions=next_actions or [],
    ).model_dump(mode="json")


def confirmation_required_response(
    *,
    action: str,
    message: str,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    return ToolResponse(
        success=False,
        action_taken="confirmation_required",
        human_summary=message,
        data={"action": action},
        next_recommended_actions=next_actions or [],
    ).model_dump(mode="json")


def inline_binary_result(
    data: bytes,
    *,
    file_name: str,
    mime_type: str,
    settings: Settings,
) -> dict[str, Any]:
    size_bytes = len(data)
    digest = hashlib.sha256(data).hexdigest()
    inline_available = size_bytes <= settings.beel_max_inline_binary_bytes

    result: dict[str, Any] = {
        "file_name": file_name,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "sha256": digest,
        "inline_available": inline_available,
    }
    if inline_available:
        result["content_base64"] = base64.b64encode(data).decode("ascii")
    else:
        result["content_base64"] = None
    return result
