from __future__ import annotations

import base64
import hashlib
from typing import Any

from fastmcp import Context

from beel_mcp.config import Settings
from beel_mcp.schemas import ToolResponse


def get_from_lifespan(ctx: Context | None, key: str) -> Any:
    if ctx is None:
        raise RuntimeError("FastMCP no inyecto Context en la tool.")
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
