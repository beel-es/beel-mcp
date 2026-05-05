# Plan de implementación OAuth — MCP de BeeL

> Plan detallado con el código exacto a añadir, basado en:
> - `GUIA_OAUTH_MCP_BEEL.md` (guía funcional del flujo)
> - `beel-api-openapi (2).yaml` (API oficial de BeeL)
> - Documentación oficial de FastMCP v3.2.4 (`OAuthProxy`, `JWTVerifier`, `get_access_token`)

---

## 0. Datos OAuth oficiales de BeeL

BeeL expone un servidor OAuth 2.1 (Spring Authorization Server). Endpoints confirmados por el equipo de BeeL:

| Endpoint | URL |
|---|---|
| Authorize | `https://app.beel.es/oauth2/authorize` |
| Token | `https://app.beel.es/oauth2/token` |
| JWKS | `https://app.beel.es/oauth2/jwks` |
| Revoke | `https://app.beel.es/oauth2/revoke` |

Metadata adicional (`GET https://app.beel.es/api/.well-known/oauth-authorization-server`):

- `grant_types_supported`: `authorization_code`, `client_credentials`, `refresh_token`, `device_code`, `token-exchange`.
- `response_types_supported`: `code`.
- `code_challenge_methods_supported`: `S256` (PKCE obligatorio, encaja con MCP spec).
- `token_endpoint_auth_methods_supported`: incluye `client_secret_basic` y `client_secret_post` (los que usa `OAuthProxy` de FastMCP por defecto).
- `introspection_endpoint`: `https://app.beel.es/oauth2/introspect` (disponible por si los tokens fueran opacos).

Credenciales de la app MCP en BeeL:

- `OAUTH_CLIENT_ID = beel-mcp` ✅ (confirmado)
- `OAUTH_CLIENT_SECRET` = pendiente (lo genera BeeL al registrar la app)

### ⚠️ Anomalía que conviene verificar antes de activar OAuth en producción

El JSON del `.well-known/oauth-authorization-server` devuelve los campos con `http://localhost:8080/api/...` (por ejemplo `issuer: "http://localhost:8080/api"`). Esto suele ocurrir cuando Spring Authorization Server no tiene `spring.security.oauth2.authorizationserver.issuer` fijado al dominio público. Implicaciones:

- El `iss` del JWT emitido **probablemente** contenga `http://localhost:8080/api` hasta que BeeL lo corrija.
- Para no romperse si BeeL lo arregla, en el primer despliegue dejamos `OAUTH_ISSUER` **vacío** → `JWTVerifier` validará solo firma (JWKS) + `audience`, no `iss`.
- Pedir a BeeL:
  1. Que confirme el `iss` real del JWT (leyendo uno decodificado).
  2. Que fije el `issuer` correcto en el metadata público.
  3. Que confirme los `scope` disponibles y si el access token sirve directamente contra `https://app.beel.es/api/*` (o si hace falta token-exchange).

---

## 1. Estado actual (lo que hay hoy)

- `src/beel_mcp/config.py`: `beel_api_key` ya es `SecretStr | None` (línea 23).
- `src/beel_mcp/client/beel_client.py`: `BeelClient` fija el header `Authorization` al construirse (líneas 36–37).
- `src/beel_mcp/server.py`: `FastMCP(name=..., lifespan=lifespan)` sin `auth=` (líneas 57–65).
- `src/beel_mcp/runtime.py`: ya hay un `resolve_api_key(ctx)` (líneas 24–46) que lee `Authorization` del request HTTP, así que el patrón "token por request" ya está parcialmente en el código.
- `fastmcp.json`: `"transport": "stdio"` (línea 18).
- `tests/conftest.py`: crea `Settings(BEEL_API_KEY="beel_sk_test_fake", ...)`.

---

## 2. Archivos que se tocan (6)

| # | Archivo | Tipo de cambio |
|---|---|---|
| 1 | `src/beel_mcp/config.py` | Añadir variables OAuth + validador |
| 2 | `src/beel_mcp/auth.py` | **Nuevo**: fábrica de `OAuthProxy` |
| 3 | `src/beel_mcp/runtime.py` | `resolve_api_key` también acepta tokens OAuth |
| 4 | `src/beel_mcp/server.py` | Cablear `auth=...` en `FastMCP(...)` |
| 5 | `fastmcp.json` | Documentar transporte HTTP para OAuth (sigue stdio por defecto) |
| 6 | `tests/conftest.py` | Fixture explícito con `OAUTH_ENABLED=False` |
| 7 | `.env.example` | **Nuevo**: plantilla con todas las variables |

> No se tocan `tools/*`, `services/*`, `policies/*`, `schemas.py`, `ui/*`.

---

## 3. Paso 1 — `src/beel_mcp/config.py`

### 3.1 Reemplazar el contenido por

```python
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuración del servidor MCP.

    Dos modos de autenticación soportados:
    - API Key (default): BEEL_API_KEY + OAUTH_ENABLED=false
    - OAuth: OAUTH_ENABLED=true + OAUTH_* obligatorios
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Modo API Key (fallback / desarrollo local) ---
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
        default=30.0, alias="BEEL_TIMEOUT_SECONDS", ge=1, le=120,
    )
    beel_max_retries: int = Field(
        default=3, alias="BEEL_MAX_RETRIES", ge=0, le=5,
    )
    beel_retry_backoff_seconds: float = Field(
        default=0.5, alias="BEEL_RETRY_BACKOFF_SECONDS", ge=0.1, le=10.0,
    )
    beel_max_inline_binary_bytes: int = Field(
        default=1_500_000,
        alias="BEEL_MAX_INLINE_BINARY_BYTES",
        ge=50_000,
        le=10_000_000,
    )

    # --- Modo OAuth ---
    oauth_enabled: bool = Field(default=False, alias="OAUTH_ENABLED")
    oauth_authorization_endpoint: str | None = Field(
        default=None, alias="OAUTH_AUTHORIZATION_ENDPOINT",
    )
    oauth_token_endpoint: str | None = Field(
        default=None, alias="OAUTH_TOKEN_ENDPOINT",
    )
    oauth_issuer: str | None = Field(default=None, alias="OAUTH_ISSUER")
    oauth_jwks_uri: str | None = Field(default=None, alias="OAUTH_JWKS_URI")
    oauth_audience: str | None = Field(default=None, alias="OAUTH_AUDIENCE")
    oauth_client_id: str | None = Field(default=None, alias="OAUTH_CLIENT_ID")
    oauth_client_secret: SecretStr | None = Field(
        default=None, alias="OAUTH_CLIENT_SECRET",
    )
    oauth_required_scopes: str | None = Field(
        default=None, alias="OAUTH_REQUIRED_SCOPES",
        description="Scopes separados por coma o espacio, ej: 'invoices:read invoices:write'",
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
                # issuer y audience NO son obligatorios: se validarán solo si
                # BeeL confirma valores correctos (hoy el metadata los devuelve
                # apuntando a localhost:8080). Ver §0.
            }
            missing = [k for k, v in required.items() if not v]
            if missing:
                raise ValueError(
                    f"OAUTH_ENABLED=true pero faltan variables: {', '.join(missing)}"
                )
        else:
            if self.beel_api_key is None:
                # Permitido (modo multi-tenant: la API key viene por header por
                # request). Solo se valida en tiempo de request vía resolve_api_key.
                pass
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
```

**Qué cambia respecto al actual**:
- Añade 9 variables `oauth_*` + `mcp_public_url`.
- Añade `@model_validator` que falla al arrancar si `OAUTH_ENABLED=true` pero falta configuración.
- Añade `required_scopes_list` (parser de scopes).

---

## 4. Paso 2 — `src/beel_mcp/auth.py` (archivo nuevo)

Aislar la construcción del `OAuthProxy` para mantener `server.py` limpio y facilitar el testing.

```python
from __future__ import annotations

from typing import Any

from beel_mcp.config import Settings


def build_auth(settings: Settings) -> Any | None:
    """Construye el `auth` para FastMCP según el modo configurado.

    - `OAUTH_ENABLED=false` → devuelve None (FastMCP sin auth, modo API Key).
    - `OAUTH_ENABLED=true`  → devuelve un `OAuthProxy` contra BeeL.
    """
    if not settings.oauth_enabled:
        return None

    # Imports locales para que el modo API Key no cargue el stack OAuth.
    from fastmcp.server.auth import OAuthProxy
    from fastmcp.server.auth.providers.jwt import JWTVerifier

    token_verifier = JWTVerifier(
        jwks_uri=settings.oauth_jwks_uri,
        # issuer y audience se validan solo si están configurados.
        # BeeL hoy devuelve iss="http://localhost:8080/api" en el metadata,
        # así que por defecto validamos solo firma hasta que lo corrijan.
        issuer=settings.oauth_issuer,
        audience=settings.oauth_audience,
    )

    return OAuthProxy(
        upstream_authorization_endpoint=settings.oauth_authorization_endpoint,
        upstream_token_endpoint=settings.oauth_token_endpoint,
        upstream_client_id=settings.oauth_client_id,
        upstream_client_secret=settings.oauth_client_secret.get_secret_value(),
        token_verifier=token_verifier,
        base_url=settings.mcp_public_url,
        # redirect_path por defecto: "/auth/callback"
        required_scopes=settings.required_scopes_list or None,
    )
```

**Variante si BeeL usa tokens opacos (no JWT):** sustituir `JWTVerifier` por introspección. Cuando BeeL lo confirme, reemplazar el `token_verifier` por:

```python
from fastmcp.server.auth.token_verification import IntrospectionTokenVerifier

token_verifier = IntrospectionTokenVerifier(
    introspection_endpoint=settings.oauth_introspection_endpoint,
    client_id=settings.oauth_client_id,
    client_secret=settings.oauth_client_secret.get_secret_value(),
)
```

(y añadir `oauth_introspection_endpoint` en `config.py`).

---

## 5. Paso 3 — `src/beel_mcp/runtime.py`

`resolve_api_key` hoy lee el header `Authorization` y cae a `settings.beel_api_key`. Con OAuth, el header traerá el **access token emitido por BeeL**, que ya es válido para la API de BeeL (es la hipótesis del flujo: el token OAuth reemplaza la API Key). Por tanto, el código existente **funciona tal cual**, pero añadimos una vía explícita usando `get_access_token()` de FastMCP que no depende del header crudo.

### 5.1 Modificar la función `resolve_api_key`

Reemplazar las líneas 24–46 de `runtime.py` por:

```python
def resolve_api_key(ctx: Context) -> str:
    """Resuelve el credencial a enviar en Authorization: Bearer a la API de BeeL.

    Prioridad:
    1. Token OAuth validado por FastMCP (modo OAuth).
    2. Header HTTP `Authorization: Bearer ...` (modo API Key multi-tenant HTTP).
    3. `settings.beel_api_key` (modo API Key stdio / desarrollo).
    """
    settings = ctx.lifespan_context.get("settings")

    # 1) Modo OAuth: token validado en memoria, sin re-parsear el header.
    if settings and settings.oauth_enabled:
        try:
            from fastmcp.server.dependencies import get_access_token
            token = get_access_token()
            if token is not None and token.token:
                return token.token
        except RuntimeError:
            pass  # fuera de contexto HTTP
        # Si OAuth está activado pero no hay token, no hay fallback seguro.
        raise RuntimeError(
            "OAuth activado pero no se encontró access token en la request."
        )

    # 2) API Key vía header HTTP (multi-tenant actual).
    try:
        request = get_http_request()
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
    except RuntimeError:
        pass  # stdio

    # 3) API Key por settings (.env).
    if settings and settings.beel_api_key:
        return settings.beel_api_key.get_secret_value()

    raise RuntimeError(
        "No se encontró credencial. Configura BEEL_API_KEY (.env), "
        "manda `Authorization: Bearer <key>` en HTTP, o activa OAUTH_ENABLED."
    )
```

**No se toca `_resolve_service_for_request` ni `get_from_lifespan`** — siguen funcionando porque el `client_cache` indexa por el string devuelto (API key **o** access token), y las llamadas a BeeL ya inyectan ese string en cada request vía `resolve_api_key`.

---

## 6. Paso 4 — `src/beel_mcp/server.py`

### 6.1 Añadir dos imports y cablear `auth=`

Al tope del archivo (tras los imports ya existentes), añadir:

```python
from beel_mcp.auth import build_auth
```

Reemplazar las líneas 57–65 (`mcp = FastMCP(...)`) por:

```python
_settings = get_settings()
_auth = build_auth(_settings)

mcp = FastMCP(
    name="BeeL MCP Server",
    instructions=(
        "Servidor MCP para operar BeeL con guardrails fiscales. "
        "Permite buscar y crear clientes, validar NIF, listar y obtener facturas, "
        "crear y emitir facturas, consultar VeriFactu, enviar por email y exportar datos."
    ),
    auth=_auth,
    lifespan=lifespan,
)
```

### 6.2 (Opcional) Ajuste en `lifespan`

`lifespan` actual crea un `default_client` solo si hay `beel_api_key`. Con OAuth, no hay API key default — los clientes se crean por request en `runtime._resolve_service_for_request`. El código **ya contempla ambos caminos** (líneas 27–42), así que no hace falta tocarlo.

### 6.3 Entrypoint HTTP para producción OAuth

`main()` (línea 137) hace `mcp.run()` sin argumentos, que usa el transporte de `fastmcp.json`. Para que el `main` también sea directamente ejecutable en modo HTTP con OAuth, reemplazar:

```python
def main() -> None:
    mcp.run()
```

por:

```python
def main() -> None:
    settings = get_settings()
    if settings.oauth_enabled:
        # OAuth exige HTTP: FastMCP rechaza stdio con auth != None.
        mcp.run(transport="http", host="0.0.0.0", port=8000)
    else:
        mcp.run()  # respeta fastmcp.json (stdio por defecto)
```

---

## 7. Paso 5 — `fastmcp.json`

No hay que cambiar el default (stdio sigue siendo el modo de desarrollo). Sí añadir un segundo fichero opcional `fastmcp.oauth.json` para despliegue:

```json
{
  "$schema": "https://gofastmcp.com/public/schemas/fastmcp.json/v1.json",
  "source": {
    "type": "filesystem",
    "path": "src/beel_mcp/server.py:mcp"
  },
  "environment": {
    "type": "uv",
    "python": ">=3.11",
    "dependencies": [
      "fastmcp[apps]>=3.2.0",
      "httpx>=0.27.0",
      "pydantic>=2.7.0",
      "pydantic-settings>=2.2.1"
    ]
  },
  "deployment": {
    "transport": "streamable-http",
    "host": "0.0.0.0",
    "port": 8000,
    "log_level": "INFO"
  }
}
```

Uso: `fastmcp run --config fastmcp.oauth.json`.

---

## 8. Paso 6 — `tests/conftest.py`

Reemplazar la fixture por:

```python
from __future__ import annotations

import pytest

from beel_mcp.config import Settings


@pytest.fixture
def mock_settings() -> Settings:
    return Settings(
        BEEL_API_KEY="beel_sk_test_fake",
        BEEL_BASE_URL="https://app.beel.es/api",
        BEEL_ENVIRONMENT="sandbox",
        BEEL_TIMEOUT_SECONDS=5,
        BEEL_MAX_RETRIES=1,
        BEEL_RETRY_BACKOFF_SECONDS=0.1,
        BEEL_MAX_INLINE_BINARY_BYTES=100_000,
        OAUTH_ENABLED=False,
    )


@pytest.fixture
def mock_oauth_settings() -> Settings:
    """Settings válidos en modo OAuth (para tests de build_auth)."""
    return Settings(
        OAUTH_ENABLED=True,
        OAUTH_AUTHORIZATION_ENDPOINT="https://app.beel.es/oauth/authorize",
        OAUTH_TOKEN_ENDPOINT="https://app.beel.es/oauth/token",
        OAUTH_JWKS_URI="https://app.beel.es/.well-known/jwks.json",
        OAUTH_ISSUER="https://app.beel.es",
        OAUTH_AUDIENCE="https://app.beel.es/api",
        OAUTH_CLIENT_ID="test-client",
        OAUTH_CLIENT_SECRET="test-secret",
        MCP_PUBLIC_URL="https://mcp.example.com",
    )
```

---

## 9. Paso 7 — `.env.example` (archivo nuevo)

```bash
# ===================================================================
# BeeL MCP — ejemplo de configuración
# ===================================================================

# --- Modo API Key (default, desarrollo local stdio) ---
BEEL_API_KEY=beel_sk_test_xxxxxxxxxxxxxxxxxxxx
BEEL_BASE_URL=https://app.beel.es/api
BEEL_ENVIRONMENT=sandbox
BEEL_TIMEOUT_SECONDS=30
BEEL_MAX_RETRIES=3
BEEL_RETRY_BACKOFF_SECONDS=0.5
BEEL_MAX_INLINE_BINARY_BYTES=1500000

# --- Modo OAuth (producción remoto multi-usuario) ---
# Activa OAUTH_ENABLED=true para protección OAuth.
# Requiere despliegue HTTP accesible en MCP_PUBLIC_URL.
OAUTH_ENABLED=false

OAUTH_AUTHORIZATION_ENDPOINT=https://app.beel.es/oauth2/authorize
OAUTH_TOKEN_ENDPOINT=https://app.beel.es/oauth2/token
OAUTH_JWKS_URI=https://app.beel.es/oauth2/jwks
# OAUTH_ISSUER: dejar vacío hasta que BeeL corrija el issuer en el metadata
# (hoy el well-known devuelve "http://localhost:8080/api" y romperá la validación).
# OAUTH_ISSUER=https://app.beel.es
# OAUTH_AUDIENCE: confirmar con BeeL el valor exacto del claim aud del JWT.
# OAUTH_AUDIENCE=https://app.beel.es/api

OAUTH_CLIENT_ID=beel-mcp
OAUTH_CLIENT_SECRET=tu-client-secret

# Opcional: scopes a pedir (separados por espacio o coma)
# OAUTH_REQUIRED_SCOPES=invoices:read invoices:write customers:read

# URL pública donde se expone este MCP (para callbacks OAuth).
MCP_PUBLIC_URL=https://beel-mcp.tudominio.com
```

---

## 10. Orden de ejecución y checklist

```
 [ ] 1. Editar config.py                     → §3
 [ ] 2. Crear src/beel_mcp/auth.py           → §4
 [ ] 3. Editar runtime.py (resolve_api_key)  → §5
 [ ] 4. Editar server.py (auth= + main)      → §6
 [ ] 5. Crear fastmcp.oauth.json             → §7
 [ ] 6. Editar tests/conftest.py             → §8
 [ ] 7. Crear .env.example                   → §9
 [ ] 8. uv sync                               → instala deps
 [ ] 9. ruff check src tests                 → lint
 [ ]10. pytest                                → tests pasan igual (modo API Key)
 [ ]11. Probar modo API Key: fastmcp run     → verificación sin regresión
 [ ]12. (Cuando BeeL confirme endpoints) rellenar .env con OAUTH_ENABLED=true
 [ ]13. Probar modo OAuth:
           fastmcp run --config fastmcp.oauth.json
        → el primer cliente MCP debe abrir navegador y hacer login en BeeL
```

---

## 11. Qué NO cambia

- 17 tools (`src/beel_mcp/tools/*`): siguen invocando services, no saben de auth.
- 7 services (`src/beel_mcp/services/*`): siguen pasando por `BeelClient`.
- `BeelClient` (§cliente HTTP): **no se toca** porque `runtime.resolve_api_key` ya resuelve por request y el mecanismo `client_cache` indexa por credencial (API key u OAuth access token).
- `schemas.py`, `policies/*`, `ui/*`, `idempotency.py`, `exceptions.py`.
- Tests existentes: el fixture sigue creando un `Settings` válido en modo API Key.

---

## 12. Riesgos y decisiones pendientes

| Riesgo | Cómo mitigarlo |
|---|---|
| `issuer` del metadata apunta a `localhost:8080` | Dejar `OAUTH_ISSUER` vacío (no validar `iss`) hasta que BeeL corrija la config del Spring AS. Validamos firma (JWKS) y `audience`. |
| Desconocemos el `aud` real del JWT que emite BeeL | Dejar `OAUTH_AUDIENCE` vacío en el primer arranque; capturar un token, decodificarlo en jwt.io, y fijar el valor. |
| BeeL emite tokens opacos en vez de JWT | BeeL anuncia `introspection_endpoint=https://app.beel.es/oauth2/introspect`. Sustituir `JWTVerifier` por `IntrospectionTokenVerifier` (§4 variante). |
| El access token no sirve directo contra `/api/*` | BeeL soporta `urn:ietf:params:oauth:grant-type:token-exchange`. Si hace falta, añadir un intercambio en `BeelClient._request` antes de llamar a BeeL API. Confirmar con BeeL. |
| Callback URL | `OAuthProxy` expone `/auth/callback` bajo `MCP_PUBLIC_URL`. Registrar esa URL exacta al dar de alta `beel-mcp` en BeeL. |
| Coste de despliegue HTTP | Railway / Fly.io / Render ≈ 5-10 €/mes (ver §6.3 de `GUIA_OAUTH_MCP_BEEL.md`). |

---

## 13. Resumen en una frase

Se añade `OAuthProxy` de FastMCP detrás de un flag `OAUTH_ENABLED`, sin tocar tools ni services: el MCP sigue funcionando en modo API Key hoy y, el día que BeeL publique OAuth, basta rellenar el `.env` y cambiar de `fastmcp.json` a `fastmcp.oauth.json` para activarlo.
