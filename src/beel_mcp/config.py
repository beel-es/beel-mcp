from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


#: Grafias publicas retiradas del entorno. Se siguen aceptando para que un `.env`
#: escrito antes del renombrado arranque igual: con un `Literal` cerrado, el cambio
#: de vocabulario se convertiria en una caida al iniciar, y quien ya tiene el
#: servidor en marcha no se entera hasta que deja de levantar.
#: Vive fuera de la clase porque pydantic trata los atributos con guion bajo como
#: privados del modelo.
LEGACY_ENVIRONMENTS = {"sandbox": "test", "production": "live", "prod": "live"}


class Settings(BaseSettings):
    """Configuracion del servidor MCP.

    BeeL usa la misma base URL para los dos entornos. La diferencia real viene
    dada por el prefijo de la API key (`beel_sk_test_` vs `beel_sk_live_`).
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
    beel_environment: Literal["test", "live"] = Field(
        default="test",
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

    @field_validator("beel_environment", mode="before")
    @classmethod
    def _accept_legacy_environment(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = value.strip().lower()
        return LEGACY_ENVIRONMENTS.get(normalized, normalized)

    @field_validator("beel_base_url")
    @classmethod
    def _normalize_base_url(cls, value: str) -> str:
        return value.rstrip("/")

    @property
    def authorization_header(self) -> str | None:
        if self.beel_api_key is None:
            return None
        return f"Bearer {self.beel_api_key.get_secret_value()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
