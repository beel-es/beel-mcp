from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuracion del servidor MCP.

    Dos modos de autenticacion:
    - API Key (default): BEEL_API_KEY + OAUTH_ENABLED=false
    - OAuth: OAUTH_ENABLED=true + OAUTH_* obligatorios
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    beel_api_key: SecretStr | None = Field(default=None, alias="BEEL_API_KEY")
    beel_base_url: str = Field(
        default="https://app.beel.es/api",
        alias="BEEL_BASE_URL",
    )
    beel_environment: Literal["sandbox", "production"] = Field(
        default="sandbox",
        alias="BEEL_ENVIRONMENT",
    )
    beel_timeout_seconds: float = Field(
        default=30.0,
        alias="BEEL_TIMEOUT_SECONDS",
        ge=1,
        le=120,
    )
    beel_max_retries: int = Field(
        default=3,
        alias="BEEL_MAX_RETRIES",
        ge=0,
        le=5,
    )
    beel_retry_backoff_seconds: float = Field(
        default=0.5,
        alias="BEEL_RETRY_BACKOFF_SECONDS",
        ge=0.1,
        le=10.0,
    )
    beel_max_inline_binary_bytes: int = Field(
        default=1_500_000,
        alias="BEEL_MAX_INLINE_BINARY_BYTES",
        ge=50_000,
        le=10_000_000,
    )

    oauth_enabled: bool = Field(default=False, alias="OAUTH_ENABLED")
    oauth_authorization_endpoint: str | None = Field(
        default=None, alias="OAUTH_AUTHORIZATION_ENDPOINT"
    )
    oauth_token_endpoint: str | None = Field(default=None, alias="OAUTH_TOKEN_ENDPOINT")
    oauth_issuer: str | None = Field(default=None, alias="OAUTH_ISSUER")
    oauth_jwks_uri: str | None = Field(default=None, alias="OAUTH_JWKS_URI")
    oauth_audience: str | None = Field(default=None, alias="OAUTH_AUDIENCE")
    oauth_client_id: str | None = Field(default=None, alias="OAUTH_CLIENT_ID")
    oauth_client_secret: SecretStr | None = Field(
        default=None, alias="OAUTH_CLIENT_SECRET"
    )
    oauth_required_scopes: str | None = Field(
        default=None,
        alias="OAUTH_REQUIRED_SCOPES",
        description="Scopes separados por coma o espacio.",
    )
    mcp_public_url: str | None = Field(default=None, alias="MCP_PUBLIC_URL")

    @field_validator("beel_base_url")
    @classmethod
    def _normalize_base_url(cls, value: str) -> str:
        return value.rstrip("/")

    @model_validator(mode="after")
    def _validate_auth_mode(self) -> "Settings":
        if self.oauth_enabled:
            required = {
                "OAUTH_AUTHORIZATION_ENDPOINT": self.oauth_authorization_endpoint,
                "OAUTH_TOKEN_ENDPOINT": self.oauth_token_endpoint,
                "OAUTH_JWKS_URI": self.oauth_jwks_uri,
                "OAUTH_CLIENT_ID": self.oauth_client_id,
                "OAUTH_CLIENT_SECRET": self.oauth_client_secret,
                "MCP_PUBLIC_URL": self.mcp_public_url,
            }
            missing = [k for k, v in required.items() if not v]
            if missing:
                raise ValueError(
                    f"OAUTH_ENABLED=true pero faltan variables: {', '.join(missing)}"
                )
        return self

    @property
    def authorization_header(self) -> str | None:
        if self.beel_api_key is None:
            return None
        return f"Bearer {self.beel_api_key.get_secret_value()}"

    @property
    def required_scopes_list(self) -> list[str]:
        raw = self.oauth_required_scopes
        if not raw:
            return []
        return [s for s in raw.replace(",", " ").split() if s]


@lru_cache
def get_settings() -> Settings:
    return Settings()
