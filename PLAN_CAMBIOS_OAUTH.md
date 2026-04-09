# Plan de cambios: Añadir OAuth al MCP de BeeL

> Este documento describe **exactamente qué archivos vamos a tocar, qué cambia en cada uno, y por qué**. No se hace ningún cambio hasta que lo apruebes.

---

## Resumen en una frase

Vamos a hacer que el MCP Server pueda recibir el token OAuth del usuario (que ya viene del cliente MCP) y lo reenvíe a la API de BeeL en vez de usar una API Key fija.

---

## ¿Qué archivos se tocan?

Solo **5 archivos existentes**. No se crea ningún archivo nuevo. No se toca ningún tool ni service.

| # | Archivo | Qué cambia | Por qué |
|---|---------|------------|---------|
| 1 | `config.py` | Se añaden variables de OAuth y `beel_api_key` pasa a ser opcional | Para que el servidor sepa dónde está el OAuth de BeeL |
| 2 | `beel_client.py` | Se añade un parámetro `token_resolver` | Para que el cliente HTTP use el token del usuario en vez de la API Key fija |
| 3 | `server.py` | Se configura `OAuthProxy` de FastMCP | Para que el MCP Server actúe como intermediario OAuth |
| 4 | `.env.example` | Se añaden las nuevas variables | Para documentar qué hay que configurar |
| 5 | `tests/conftest.py` | Se ajusta el mock de Settings | Para que los tests sigan pasando |

### Archivos que NO se tocan (y por qué)

| Archivo | Por qué no cambia |
|---------|-------------------|
| `tools/*.py` | Los tools no saben nada de autenticación. Llaman a los services y ya |
| `services/*.py` | Los services llaman a BeelClient, que resuelve el token internamente |
| `schemas.py` | No tiene nada que ver con auth |
| `policies/*.py` | Son reglas de negocio, no de auth |
| `runtime.py` | Las helpers siguen funcionando igual |

---

## Cambio 1: `config.py`

### ¿Qué hay ahora?

```python
beel_api_key: SecretStr = Field(alias="BEEL_API_KEY")  # Obligatorio siempre
```

### ¿Qué va a haber?

```python
# La API Key pasa a ser opcional (no hace falta cuando usas OAuth)
beel_api_key: SecretStr | None = Field(default=None, alias="BEEL_API_KEY")

# Se añaden estas variables nuevas:
oauth_enabled: bool = False                          # Interruptor on/off
oauth_authorization_endpoint: str | None = None      # URL de login de BeeL
oauth_token_endpoint: str | None = None              # URL para obtener tokens
oauth_client_id: str | None = None                   # ID de nuestra app en BeeL
oauth_client_secret: SecretStr | None = None         # Secreto de nuestra app
oauth_jwks_uri: str | None = None                    # URL para verificar tokens
oauth_audience: str | None = None                    # Identificador de la API
mcp_public_url: str | None = None                    # URL pública del MCP Server
```

### Validación que se añade

```
Si OAUTH_ENABLED=false → BEEL_API_KEY es obligatorio (como ahora)
Si OAUTH_ENABLED=true  → Los campos OAuth son obligatorios, BEEL_API_KEY es opcional
```

### ¿Por qué?

Para poder arrancar el servidor en dos modos:
- **Modo API Key** (como ahora): `OAUTH_ENABLED=false` + `BEEL_API_KEY=beel_sk_...`
- **Modo OAuth**: `OAUTH_ENABLED=true` + variables OAuth

---

## Cambio 2: `beel_client.py`

### ¿Qué hay ahora?

El `BeelClient` se crea con un API Key fija que se mete en el header de TODAS las peticiones:

```python
class BeelClient:
    def __init__(self, settings):
        self._client = httpx.AsyncClient(
            headers={"Authorization": settings.authorization_header}  # ← Fijo
        )
```

Cada vez que el client llama a la API de BeeL, manda esa misma API Key.

### ¿Qué va a haber?

Se añade un parámetro opcional `token_resolver`: una función que, cuando se llama, devuelve el token del usuario actual.

```python
class BeelClient:
    def __init__(self, settings, *, token_resolver=None):
        self._token_resolver = token_resolver
        self._client = httpx.AsyncClient(
            headers={"Accept": "application/json"}  # ← Sin Authorization fijo
        )

    async def _request(self, method, path, ...):
        headers = ...
        # Resolver el token para ESTA petición
        if self._token_resolver:
            token = self._token_resolver()
            if token:
                headers["Authorization"] = f"Bearer {token}"
        elif self._settings.authorization_header:
            headers["Authorization"] = self._settings.authorization_header
        ...
```

### ¿Por qué?

Porque con OAuth, cada usuario tiene su propio token. No podemos meter un token fijo cuando se crea el client — tiene que resolverse en el momento de cada petición.

### ¿Qué es `token_resolver`?

Es simplemente una función sin argumentos que devuelve el token actual:

```python
def mi_resolver():
    token_obj = get_access_token()  # ← FastMCP nos da el token del usuario actual
    return token_obj.token if token_obj else None
```

FastMCP tiene una función `get_access_token()` que, cuando se ejecuta dentro de un tool, devuelve automáticamente el token del usuario que está haciendo la petición. Nosotros solo le preguntamos "¿quién es el usuario actual?" y reenviamos su token a BeeL.

### ¿Cambian los métodos del client (list_customers, create_invoice, etc.)?

**No.** Todos siguen exactamente igual. El cambio está solo en `_request` (el método interno que todos usan).

---

## Cambio 3: `server.py`

### ¿Qué hay ahora?

```python
mcp = FastMCP(
    name="BeeL MCP Server",
    lifespan=lifespan,
)
```

El servidor arranca sin autenticación (modo stdio local).

### ¿Qué va a haber?

```python
settings = get_settings()
auth = None

if settings.oauth_enabled:
    from fastmcp.server.auth import OAuthProxy
    from fastmcp.server.auth.providers.jwt import JWTVerifier

    auth = OAuthProxy(
        upstream_authorization_endpoint=settings.oauth_authorization_endpoint,
        upstream_token_endpoint=settings.oauth_token_endpoint,
        upstream_client_id=settings.oauth_client_id,
        upstream_client_secret=settings.oauth_client_secret.get_secret_value(),
        token_verifier=JWTVerifier(
            jwks_uri=settings.oauth_jwks_uri,
            audience=settings.oauth_audience,
        ),
        base_url=settings.mcp_public_url,
    )

mcp = FastMCP(
    name="BeeL MCP Server",
    auth=auth,         # ← None si no hay OAuth, OAuthProxy si hay
    lifespan=lifespan,
)
```

### Cambio en el lifespan

```python
@asynccontextmanager
async def lifespan(_: FastMCP):
    settings = get_settings()

    # Si OAuth está activado, el token viene del usuario autenticado
    token_resolver = None
    if settings.oauth_enabled:
        from fastmcp.server.dependencies import get_access_token
        def token_resolver():
            t = get_access_token()
            return t.token if t else None

    beel_client = BeelClient(settings, token_resolver=token_resolver)
    ...
```

### ¿Por qué?

El `OAuthProxy` de FastMCP hace todo el trabajo pesado:
1. Expone los endpoints de discovery (`/.well-known/...`)
2. Redirige al usuario a BeeL para que haga login
3. Intercambia el código por un token
4. Valida los tokens en cada petición

Nosotros solo le decimos "oye, el OAuth de BeeL está en estas URLs" y FastMCP se encarga del resto.

---

## Cambio 4: `.env.example`

### ¿Qué hay ahora?

```bash
BEEL_API_KEY=beel_sk_test_xxxxxxxxxxxxxxxxxxxx
BEEL_BASE_URL=https://app.beel.es/api
# ... etc
```

### ¿Qué va a haber?

```bash
# === Modo API Key (desarrollo local) ===
BEEL_API_KEY=beel_sk_test_xxxxxxxxxxxxxxxxxxxx
BEEL_BASE_URL=https://app.beel.es/api
BEEL_ENVIRONMENT=sandbox
BEEL_TIMEOUT_SECONDS=30
BEEL_MAX_RETRIES=3
BEEL_RETRY_BACKOFF_SECONDS=0.5
BEEL_MAX_INLINE_BINARY_BYTES=1500000

# === OAuth (producción) ===
# Pon OAUTH_ENABLED=true para activar OAuth y desactivar API Key
OAUTH_ENABLED=false
OAUTH_AUTHORIZATION_ENDPOINT=https://app.beel.es/oauth/authorize
OAUTH_TOKEN_ENDPOINT=https://app.beel.es/oauth/token
OAUTH_CLIENT_ID=tu-client-id
OAUTH_CLIENT_SECRET=tu-client-secret
OAUTH_JWKS_URI=https://app.beel.es/.well-known/jwks.json
OAUTH_AUDIENCE=https://app.beel.es/api
MCP_PUBLIC_URL=https://tu-mcp-server.com
```

---

## Cambio 5: `tests/conftest.py`

### ¿Qué cambia?

El mock de `Settings` tiene `beel_api_key` que ahora es opcional. Solo hay que asegurarse de que sigue pasando un valor en los tests (porque los tests usan modo API Key).

```python
# Antes:
Settings(BEEL_API_KEY="beel_sk_test_fake123", ...)

# Después (igual, sigue funcionando porque API Key mode está activo):
Settings(BEEL_API_KEY="beel_sk_test_fake123", OAUTH_ENABLED=False, ...)
```

Los tests existentes no cambian de comportamiento.

---

## Diagrama: flujo actual vs flujo con OAuth

### Ahora (API Key)

```
Claude Desktop ──stdio──► MCP Server ──API Key fija──► BeeL API
                           (local)      beel_sk_...
```

### Con OAuth

```
Claude Desktop ──HTTP──► MCP Server ──Token del usuario──► BeeL API
     │                    (remoto)     eyJhbG...
     │                       ▲
     │    Login en BeeL      │ valida token
     └──────────────────► BeeL OAuth
```

---

## ¿Qué necesitas tener listo antes de implementar?

Esto NO bloquea la implementación del código, pero sí bloquea poder probarlo:

| # | Qué necesitas | De dónde sale |
|---|---------------|---------------|
| 1 | **URLs OAuth de BeeL** (authorize, token, jwks) | Que el equipo de BeeL te las dé |
| 2 | **Client ID y Client Secret** | Registrar tu app en BeeL |
| 3 | **URL pública del MCP Server** | Desplegar en Railway/Render/etc. |

---

## ¿Qué NO cambia?

- Los 17 tools siguen exactamente igual
- Los 7 services siguen exactamente igual
- Las policies y el state machine no cambian
- Los schemas no cambian
- El modo API Key sigue funcionando (`OAUTH_ENABLED=false`)
- Los tests existentes siguen pasando

---

## Orden de implementación

```
1. config.py          ← Añadir variables OAuth (2 min)
2. beel_client.py     ← Añadir token_resolver (2 min)
3. server.py          ← Configurar OAuthProxy (3 min)
4. .env.example       ← Documentar variables (1 min)
5. tests/conftest.py  ← Ajustar mock (1 min)
6. pytest + ruff      ← Verificar que todo pasa (1 min)
```

Total: ~10 minutos de implementación.
