from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from beel_mcp.config import Settings
from beel_mcp.runtime import (
    _SERVICE_NAMES,
    _resolve_service_for_request,
    get_from_lifespan,
    resolve_api_key,
)


def _make_settings(*, api_key: str | None = None) -> Settings:
    kwargs: dict = {
        "BEEL_BASE_URL": "https://app.beel.es/api",
        "BEEL_ENVIRONMENT": "sandbox",
        "BEEL_TIMEOUT_SECONDS": 5,
        "BEEL_MAX_RETRIES": 1,
        "BEEL_RETRY_BACKOFF_SECONDS": 0.1,
        "BEEL_MAX_INLINE_BINARY_BYTES": 100_000,
    }
    if api_key is not None:
        kwargs["BEEL_API_KEY"] = api_key
    return Settings(**kwargs, _env_file=None)


def _make_ctx(lifespan_context: dict) -> MagicMock:
    ctx = MagicMock()
    ctx.lifespan_context = lifespan_context
    return ctx


# ---------------------------------------------------------------------------
# resolve_api_key
# ---------------------------------------------------------------------------


class TestResolveApiKey:
    def test_returns_key_from_settings_when_no_http_request(self):
        settings = _make_settings(api_key="beel_sk_test_abc")
        ctx = _make_ctx({"settings": settings})

        with patch(
            "beel_mcp.runtime.get_http_request",
            side_effect=RuntimeError("no HTTP"),
        ):
            key = resolve_api_key(ctx)

        assert key == "beel_sk_test_abc"

    def test_extracts_key_from_authorization_header(self):
        settings = _make_settings(api_key="beel_sk_test_abc")
        ctx = _make_ctx({"settings": settings})

        mock_request = MagicMock()
        mock_request.headers = {"authorization": "Bearer beel_sk_live_http_user"}

        with patch(
            "beel_mcp.runtime.get_http_request",
            return_value=mock_request,
        ):
            key = resolve_api_key(ctx)

        assert key == "beel_sk_live_http_user"

    def test_raises_when_no_key_anywhere(self):
        settings = _make_settings()  # no API key
        ctx = _make_ctx({"settings": settings})

        with patch(
            "beel_mcp.runtime.get_http_request",
            side_effect=RuntimeError("no HTTP"),
        ):
            with pytest.raises(RuntimeError, match="No se encontro credencial"):
                resolve_api_key(ctx)

    def test_ignores_non_bearer_auth_header(self):
        settings = _make_settings(api_key="beel_sk_test_fallback")
        ctx = _make_ctx({"settings": settings})

        mock_request = MagicMock()
        mock_request.headers = {"authorization": "Basic dXNlcjpwYXNz"}

        with patch(
            "beel_mcp.runtime.get_http_request",
            return_value=mock_request,
        ):
            key = resolve_api_key(ctx)

        assert key == "beel_sk_test_fallback"


# ---------------------------------------------------------------------------
# _resolve_service_for_request
# ---------------------------------------------------------------------------


class TestResolveServiceForRequest:
    def test_reuses_lifespan_service_for_default_key(self):
        settings = _make_settings(api_key="beel_sk_test_default")
        sentinel_service = object()
        ctx = _make_ctx({
            "settings": settings,
            "client_cache": {},
            "customer_service": sentinel_service,
        })

        with patch(
            "beel_mcp.runtime.get_http_request",
            side_effect=RuntimeError("no HTTP"),
        ):
            result = _resolve_service_for_request(ctx, "customer_service")

        assert result is sentinel_service

    def test_creates_new_services_for_different_key(self):
        settings = _make_settings(api_key="beel_sk_test_default")
        client_cache: dict = {}
        ctx = _make_ctx({
            "settings": settings,
            "client_cache": client_cache,
            "customer_service": object(),
        })

        mock_request = MagicMock()
        mock_request.headers = {"authorization": "Bearer beel_sk_test_other_user"}

        with patch(
            "beel_mcp.runtime.get_http_request",
            return_value=mock_request,
        ):
            result = _resolve_service_for_request(ctx, "customer_service")

        assert "beel_sk_test_other_user" in client_cache
        assert result is client_cache["beel_sk_test_other_user"]["customer_service"]

    def test_caches_services_across_calls(self):
        settings = _make_settings(api_key="beel_sk_test_default")
        client_cache: dict = {}
        ctx = _make_ctx({
            "settings": settings,
            "client_cache": client_cache,
            "customer_service": object(),
            "invoice_service": object(),
        })

        mock_request = MagicMock()
        mock_request.headers = {"authorization": "Bearer beel_sk_test_user2"}

        with patch(
            "beel_mcp.runtime.get_http_request",
            return_value=mock_request,
        ):
            svc1 = _resolve_service_for_request(ctx, "customer_service")
            svc2 = _resolve_service_for_request(ctx, "customer_service")

        assert svc1 is svc2

    def test_creates_services_when_no_default_key(self):
        settings = _make_settings()  # no default API key
        client_cache: dict = {}
        ctx = _make_ctx({
            "settings": settings,
            "client_cache": client_cache,
        })

        mock_request = MagicMock()
        mock_request.headers = {"authorization": "Bearer beel_sk_test_http_only"}

        with patch(
            "beel_mcp.runtime.get_http_request",
            return_value=mock_request,
        ):
            result = _resolve_service_for_request(ctx, "invoice_service")

        assert "beel_sk_test_http_only" in client_cache
        assert result is client_cache["beel_sk_test_http_only"]["invoice_service"]


# ---------------------------------------------------------------------------
# get_from_lifespan
# ---------------------------------------------------------------------------


class TestGetFromLifespan:
    def test_raises_when_ctx_is_none(self):
        with pytest.raises(RuntimeError, match="FastMCP no inyecto"):
            get_from_lifespan(None, "settings")

    def test_returns_non_service_key_directly(self):
        settings = _make_settings(api_key="beel_sk_test_abc")
        ctx = _make_ctx({"settings": settings})
        assert get_from_lifespan(ctx, "settings") is settings

    def test_delegates_service_key_to_resolver(self):
        settings = _make_settings(api_key="beel_sk_test_abc")
        sentinel = object()
        ctx = _make_ctx({
            "settings": settings,
            "client_cache": {},
            "customer_service": sentinel,
        })

        with patch(
            "beel_mcp.runtime.get_http_request",
            side_effect=RuntimeError("no HTTP"),
        ):
            result = get_from_lifespan(ctx, "customer_service")

        assert result is sentinel

    def test_raises_for_missing_non_service_key(self):
        ctx = _make_ctx({"settings": _make_settings(api_key="x")})
        with pytest.raises(RuntimeError, match="No se encontro `bogus`"):
            get_from_lifespan(ctx, "bogus")
