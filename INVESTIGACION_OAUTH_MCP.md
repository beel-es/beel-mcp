# Investigación: Añadir OAuth al MCP de BeeL

**Fecha:** 2026-04-07
**Objetivo:** Analizar qué se necesita para permitir el uso del MCP Server a través de OAuth, investigando tanto la API de BeeL como las capacidades de FastMCP y la especificación MCP.

---

## 1. Estado actual de la autenticación

### 1.1 BeeL API (según OpenAPI spec)

BeeL actualmente soporta **solo dos métodos** de autenticación:

| Método | Tipo | Uso |
|--------|------|-----|
| `ApiKeyAuth` | Bearer token (`beel_sk_*`) | Acceso programático (recomendado) |
| `SessionCookie` | Cookie `BEEL_SESSION` | Acceso web/browser |

**No existe ningún endpoint OAuth** en la API de BeeL (no hay `/oauth/authorize`, `/oauth/token`, ni metadata en `/.well-known/`).

### 1.2 MCP Server actual

El servidor MCP actual usa API Key directamente:
- Se configura vía variable de entorno `BEEL_API_KEY`
- El `BeelClient` inyecta el header `Authorization: Bearer beel_sk_...` en cada petición
- No hay capa de autenticación entre el cliente MCP (Claude, etc.) y el servidor MCP — el MCP corre en modo **stdio** (local)

---

## 2. ¿Qué dice la especificación MCP sobre autenticación?

La especificación MCP (versión 2025-06-18+) define un modelo de autorización basado en **OAuth 2.1**:

### Estándares requeridos:
- **OAuth 2.1** como framework de autorización principal
- **RFC 9728** — Protected Resource Metadata (`/.well-known/oauth-protected-resource`)
- **RFC 8414** — Authorization Server Metadata discovery
- **RFC 7591** — Dynamic Client Registration (opcional, para compatibilidad)
- **RFC 8707** — Resource Indicators (parámetro `resource` en peticiones)

### Flujo definido por MCP:
1. Cliente MCP hace petición → recibe `401 Unauthorized`
2. Cliente descubre el Authorization Server vía `/.well-known/oauth-protected-resource`
3. Cliente obtiene metadata del AS vía `/.well-known/oauth-authorization-server`
4. Cliente se registra dinámicamente (RFC 7591) o usa credenciales pre-registradas
5. Cliente inicia flujo OAuth (authorization_code + PKCE)
6. Cliente obtiene access token y lo envía como `Authorization: Bearer <token>`
7. Servidor MCP valida el token (firma, expiración, audience)

---

## 3. ¿Qué ofrece FastMCP para OAuth?

FastMCP v3.2+ incluye soporte nativo para OAuth a través del módulo `fastmcp.server.auth`. Ofrece dos mecanismos:

### 3.1 `BearerTokenAuth` — Autenticación simple por token

Para proteger el servidor MCP con un token estático (sin flujo OAuth completo):

```python
from fastmcp import FastMCP
from fastmcp.server.auth import BearerTokenAuth

auth = BearerTokenAuth(token="mi-token-secreto")
mcp = FastMCP("Mi Servidor", auth=auth)
```

**Limitación:** Requiere distribuir el token manualmente. No hay flujo interactivo.

### 3.2 `OAuthProxy` — Proxy OAuth completo (RECOMENDADO)

FastMCP actúa como **proxy OAuth** entre el cliente MCP y un proveedor OAuth externo. Gestiona automáticamente:

- Discovery metadata (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`)
- Dynamic Client Registration (RFC 7591)
- Authorization Code flow con PKCE
- Callback handling
- Token validation (JWT o introspección)

```python
from fastmcp import FastMCP
from fastmcp.server.auth import OAuthProxy
from fastmcp.server.auth.providers.jwt import JWTVerifier

token_verifier = JWTVerifier(
    jwks_uri="https://provider.com/.well-known/jwks.json",
    issuer="https://provider.com",
    audience="my-app-id"
)

auth = OAuthProxy(
    upstream_authorization_endpoint="https://provider.com/oauth/authorize",
    upstream_token_endpoint="https://provider.com/oauth/token",
    upstream_client_id="client-id",
    upstream_client_secret="client-secret",
    token_verifier=token_verifier,
    base_url="https://my-mcp-server.com",
)

mcp = FastMCP(name="My Server", auth=auth)
```

### 3.3 Token Verifiers disponibles

| Verifier | Uso | Proveedores |
|----------|-----|-------------|
| `JWTVerifier` | Tokens JWT con JWKS | Google, Azure AD, AWS Cognito |
| `IntrospectionTokenVerifier` | Tokens opacos con introspección | Auth0, Okta, WorkOS |
| `GitHubTokenVerifier` | Específico para GitHub | GitHub |

### 3.4 Parámetros clave de `OAuthProxy`

| Parámetro | Descripción |
|-----------|-------------|
| `upstream_authorization_endpoint` | URL de autorización del proveedor OAuth |
| `upstream_token_endpoint` | URL de token del proveedor OAuth |
| `upstream_client_id` | Client ID registrado en el proveedor |
| `upstream_client_secret` | Client Secret (opcional con PKCE) |
| `token_verifier` | Instancia de TokenVerifier |
| `base_url` | URL pública del servidor MCP |
| `redirect_path` | Path del callback (default: `/auth/callback`) |
| `required_scopes` | Scopes requeridos |
| `forward_pkce` | Reenviar PKCE al upstream (default: `True`) |
| `extra_authorize_params` | Params adicionales para authorize (ej: `audience` en Auth0) |
| `extra_token_params` | Params adicionales para token |

---

## 4. Opciones de implementación

Dado que **BeeL no tiene OAuth propio**, hay tres estrategias posibles:

### Opción A: OAuth con proveedor externo (Auth0, Google, etc.)

**Concepto:** Usar un Identity Provider (IdP) externo para autenticar usuarios del MCP. El servidor MCP valida la identidad del usuario y luego usa la API Key de BeeL internamente.

```
┌─────────┐     OAuth 2.1      ┌──────────┐     API Key      ┌──────────┐
│  Claude  │ ◄──────────────► │  MCP     │ ──────────────► │  BeeL    │
│  Client  │   (user auth)    │  Server  │  (beel_sk_...)   │  API     │
└─────────┘                   └──────────┘                  └──────────┘
                                   ▲
                                   │ validates token
                                   ▼
                              ┌──────────┐
                              │   IdP    │
                              │ (Auth0)  │
                              └──────────┘
```

**Cambios necesarios:**
1. Cambiar transporte de `stdio` a `streamable-http` (OAuth requiere HTTP)
2. Configurar `OAuthProxy` en `server.py` con endpoints del IdP
3. Configurar token verifier (JWT o introspección)
4. Registrar app OAuth en el IdP elegido
5. Mapear usuarios autenticados a API Keys de BeeL (multi-tenant)
6. Añadir variables de entorno para OAuth config

**Pros:**
- Seguridad robusta con estándares probados
- Multi-usuario / multi-tenant posible
- Cada usuario puede tener su propia API Key de BeeL
- Compatible con la especificación MCP

**Contras:**
- Requiere un IdP externo (coste adicional)
- Complejidad de setup significativa
- BeeL sigue usando API Key internamente — OAuth solo protege el acceso al MCP
- Necesita despliegue HTTP (no puede ser solo stdio local)

### Opción B: BeeL implementa OAuth nativo

**Concepto:** Esperar o solicitar a BeeL que implemente endpoints OAuth en su API.

**Endpoints que BeeL necesitaría exponer:**
- `GET /oauth/authorize` — Authorization endpoint
- `POST /oauth/token` — Token endpoint
- `GET /.well-known/jwks.json` — JWKS para validación de tokens
- `GET /.well-known/oauth-authorization-server` — Metadata discovery
- `POST /oauth/register` — Dynamic Client Registration (opcional)

**Cambios necesarios en el MCP:**
1. Cambiar transporte a `streamable-http`
2. Configurar `OAuthProxy` apuntando a endpoints de BeeL
3. Eliminar `BEEL_API_KEY` — los tokens OAuth reemplazan la API Key
4. Actualizar `BeelClient` para usar tokens OAuth en vez de API Key estática

**Pros:**
- Solución más limpia — un solo sistema de auth end-to-end
- No hay servicios externos adicionales
- Los tokens tienen scopes, expiración, revocación

**Contras:**
- Depende completamente de BeeL — no está disponible actualmente
- Sin fecha de implementación conocida

### Opción C: Proxy OAuth ligero con API Key mapping (PRAGMÁTICA)

**Concepto:** Implementar OAuth en el MCP usando un IdP externo, pero con una capa simple que mapea usuarios OAuth a API Keys de BeeL almacenadas de forma segura.

```python
# Ejemplo conceptual de la arquitectura

from fastmcp import FastMCP
from fastmcp.server.auth import OAuthProxy
from fastmcp.server.auth.providers.jwt import JWTVerifier

# 1. Configurar OAuth con Auth0
token_verifier = JWTVerifier(
    jwks_uri="https://mi-tenant.auth0.com/.well-known/jwks.json",
    issuer="https://mi-tenant.auth0.com/",
    audience="https://beel-mcp.example.com"
)

auth = OAuthProxy(
    upstream_authorization_endpoint="https://mi-tenant.auth0.com/authorize",
    upstream_token_endpoint="https://mi-tenant.auth0.com/oauth/token",
    upstream_client_id="AUTH0_CLIENT_ID",
    upstream_client_secret="AUTH0_CLIENT_SECRET",
    token_verifier=token_verifier,
    base_url="https://beel-mcp.example.com",
    extra_authorize_params={"audience": "https://beel-mcp.example.com"},
)

mcp = FastMCP(name="BeeL MCP Server", auth=auth, lifespan=lifespan)

# 2. En el lifespan, resolver la API Key de BeeL para el usuario autenticado
# (desde DB, vault, o variable de entorno si es single-tenant)
```

**Cambios necesarios:**
1. Cambiar transporte de `stdio` a `streamable-http`
2. Añadir `OAuthProxy` a la configuración del MCP
3. Añadir mapping usuario→API Key (puede ser simple env var si es single-tenant)
4. Actualizar `config.py` con settings de OAuth
5. Actualizar `fastmcp.json` para HTTP transport
6. Actualizar `pyproject.toml` si se necesitan dependencias extra

---

## 5. Cambios concretos en el código actual

### 5.1 Archivos que se modificarían

| Archivo | Cambio |
|---------|--------|
| `server.py` | Añadir `auth=OAuthProxy(...)` al constructor de `FastMCP` |
| `config.py` | Nuevos settings: `OAUTH_*` (issuer, client_id, secret, jwks_uri, audience) |
| `fastmcp.json` | Cambiar transport de `stdio` a `streamable-http`, añadir host/port |
| `pyproject.toml` | Posible dependencia adicional (`PyJWT`, `cryptography` si no vienen con FastMCP) |
| `.env.example` | Nuevas variables de OAuth |

### 5.2 Nuevos archivos potenciales

| Archivo | Propósito |
|---------|-----------|
| `src/beel_mcp/auth.py` | Factory para crear OAuthProxy desde Settings |
| `src/beel_mcp/auth_middleware.py` | Middleware para extraer user info del token y resolver API Key |

### 5.3 Ejemplo de `config.py` extendido

```python
class Settings(BaseSettings):
    # ... existentes ...
    BEEL_API_KEY: str  # Se mantiene como fallback o single-tenant

    # OAuth (opcionales — si no se configuran, OAuth está desactivado)
    OAUTH_ENABLED: bool = False
    OAUTH_ISSUER: str | None = None
    OAUTH_CLIENT_ID: str | None = None
    OAUTH_CLIENT_SECRET: str | None = None
    OAUTH_JWKS_URI: str | None = None
    OAUTH_AUDIENCE: str | None = None
    OAUTH_BASE_URL: str | None = None  # URL pública del MCP
```

### 5.4 Ejemplo de `server.py` modificado

```python
from fastmcp import FastMCP
from beel_mcp.config import get_settings

settings = get_settings()
auth = None

if settings.OAUTH_ENABLED:
    from fastmcp.server.auth import OAuthProxy
    from fastmcp.server.auth.providers.jwt import JWTVerifier

    auth = OAuthProxy(
        upstream_authorization_endpoint=f"{settings.OAUTH_ISSUER}/authorize",
        upstream_token_endpoint=f"{settings.OAUTH_ISSUER}/oauth/token",
        upstream_client_id=settings.OAUTH_CLIENT_ID,
        upstream_client_secret=settings.OAUTH_CLIENT_SECRET,
        token_verifier=JWTVerifier(
            jwks_uri=settings.OAUTH_JWKS_URI,
            issuer=settings.OAUTH_ISSUER,
            audience=settings.OAUTH_AUDIENCE,
        ),
        base_url=settings.OAUTH_BASE_URL,
    )

mcp = FastMCP(
    name="BeeL MCP Server",
    auth=auth,  # None = sin auth (stdio), OAuthProxy = con OAuth (http)
    lifespan=lifespan,
)
```

---

## 6. Requisitos previos

Antes de implementar OAuth, se necesita:

1. **Decidir el IdP** — Auth0, Google Cloud Identity, Azure AD, Keycloak (self-hosted), etc.
2. **Registrar la aplicación OAuth** en el IdP elegido
3. **Desplegar el MCP en HTTP** — OAuth no funciona con transporte stdio (local)
4. **Definir el modelo de tenancy:**
   - **Single-tenant:** Una sola API Key de BeeL, OAuth solo controla acceso al MCP
   - **Multi-tenant:** Cada usuario OAuth tiene su propia API Key de BeeL
5. **URL pública** para el servidor MCP (necesaria para callbacks OAuth)

---

## 7. Recomendación

### Para uso inmediato (single-user, local):
**No se necesita OAuth.** El modo `stdio` con API Key es suficiente y más simple.

### Para despliegue compartido (multi-user, remoto):
**Opción C (Proxy OAuth con IdP externo)** es la más pragmática:
- FastMCP ya tiene todo el soporte necesario con `OAuthProxy`
- No depende de que BeeL implemente OAuth
- Se puede empezar con Auth0 (free tier: 7.000 usuarios activos)
- La API Key de BeeL se usa internamente como "service account"

### Para el futuro ideal:
**Opción B (OAuth nativo de BeeL)** sería lo más limpio, pero requiere que BeeL lo implemente.

---

## 8. Resumen ejecutivo

| Aspecto | Estado |
|---------|--------|
| BeeL tiene OAuth | **No** — solo API Key y Session Cookie |
| FastMCP soporta OAuth | **Sí** — `OAuthProxy` + `JWTVerifier` / `IntrospectionTokenVerifier` |
| MCP spec define OAuth | **Sí** — OAuth 2.1 con RFC 9728, 8414, 7591, 8707 |
| Se puede implementar hoy | **Sí** — usando un IdP externo (Auth0, Google, etc.) |
| Requiere cambio de transporte | **Sí** — de `stdio` a `streamable-http` |
| Complejidad estimada | Media — los cambios son localizados en `server.py` y `config.py` |
