# Playbook: obtener un access token OAuth de BeeL para debug

Este documento describe paso a paso cómo intentar obtener un JWT real desde el Spring Authorization Server de BeeL para inspeccionar sus claims (`iss`, `aud`, `scope`, etc.) y configurar correctamente el `JWTVerifier` del MCP. Está pensado para que otro agente de IA (o ingeniero) lo reproduzca sin contexto previo.

---

## 1. Contexto del sistema

```
Levante (cliente, app de escritorio)
   │
   │  HTTP/MCP + Bearer token
   ▼
MCP BeeL  (este repo: /Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp)
   │
   │  HTTP + Bearer token
   ▼
API BeeL  (https://test.beel.es/api/*)
   │
   │  emite tokens vía
   ▼
Spring Authorization Server BeeL
   - https://test.beel.es/api/oauth2/authorize
   - https://test.beel.es/api/oauth2/token
   - https://test.beel.es/api/oauth2/jwks
```

- **Levante** descubre el MCP, hace DCR (Dynamic Client Registration) contra el MCP, y arranca un flujo `authorization_code+PKCE`.
- **El MCP** actúa como **OAuthProxy** (FastMCP v3.2.x): recibe el `/authorize` de Levante, lo reescribe y redirige a `https://test.beel.es/api/oauth2/authorize` con `client_id=beel-mcp` (las credenciales configuradas en `.env`).
- **BeeL** valida el cliente, hace login del usuario humano, devuelve un `code`, el MCP lo intercambia por un JWT y se lo entrega a Levante.

Nuestro objetivo aquí es **conseguir un JWT** y decodificarlo para ver qué claims emite BeeL. Sin esa información, no podemos configurar `OAUTH_AUDIENCE` ni validar el `iss` correctamente.

---

## 2. Credenciales y endpoints

Archivo: `/Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp/.env`

```
OAUTH_ENABLED=true
OAUTH_AUTHORIZATION_ENDPOINT=https://test.beel.es/api/oauth2/authorize
OAUTH_TOKEN_ENDPOINT=https://test.beel.es/api/oauth2/token
OAUTH_JWKS_URI=https://test.beel.es/api/oauth2/jwks
OAUTH_ISSUER=https://test.beel.es/api
OAUTH_CLIENT_ID=beel-mcp
OAUTH_CLIENT_SECRET=Kx7mR2vQpYnL8wBjT4sHdF9gN6cA3eZu
OAUTH_REQUIRED_SCOPES=invoices:read invoices:write customers:read customers:write
MCP_PUBLIC_URL=http://localhost:8000
```

> ⚠️ El secret `Kx7mR2vQpYnL8wBjT4sHdF9gN6cA3eZu` solo es válido en `test.beel.es`. En `app.beel.es` (prod) las mismas credenciales devuelven `401 invalid_client` (no existe el cliente, o el secret es distinto).

---

## 3. Verificaciones iniciales (correr siempre antes)

### 3.1. Comprobar metadata del Spring AS

```bash
curl -sS https://test.beel.es/api/.well-known/oauth-authorization-server | python3 -m json.tool
```

**Esperado:**
- `issuer = "https://test.beel.es/api"` (correcto en test; en prod está roto: `http://localhost:8080/api`)
- `grant_types_supported` incluye `client_credentials`, `authorization_code`, `refresh_token`
- `token_endpoint_auth_methods_supported` incluye `client_secret_basic`, `client_secret_post`
- `code_challenge_methods_supported = ["S256"]` (PKCE obligatorio)

### 3.2. Comprobar que el MCP local está corriendo y apunta al entorno correcto

```bash
# ¿Está vivo?
lsof -ti:8000 || echo "NO está corriendo"

# Si no, arrancarlo:
cd /Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp
nohup uv run python -m beel_mcp.server > /tmp/beel_mcp_oauth.log 2>&1 &

# Verificar metadata publicada por el MCP
curl -sS http://localhost:8000/.well-known/oauth-authorization-server | python3 -m json.tool
```

**Esperado en la metadata del MCP:**
```json
{
  "scopes_supported": ["invoices:read", "invoices:write", "customers:read", "customers:write"],
  "code_challenge_methods_supported": ["S256"],
  "grant_types_supported": ["authorization_code", "refresh_token"]
}
```

### 3.3. Confirmar que el OAuthProxy carga los endpoints correctos

```bash
cd /Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp
uv run python -c "
from beel_mcp.config import get_settings
from beel_mcp.auth import build_auth
get_settings.cache_clear()
s = get_settings()
proxy = build_auth(s)
print('upstream_authorization_endpoint:', proxy._upstream_authorization_endpoint)
print('upstream_token_endpoint:        ', proxy._upstream_token_endpoint)
print('upstream_client_id:             ', proxy._upstream_client_id)
"
```

**Esperado:**
```
upstream_authorization_endpoint: https://test.beel.es/api/oauth2/authorize
upstream_token_endpoint:         https://test.beel.es/api/oauth2/token
upstream_client_id:              beel-mcp
```

---

## 4. Métodos para obtener el token (en orden de menor fricción)

### Método A — `client_credentials` (machine-to-machine)

> ⚠️ Esta llamada envía el `client_secret` a un endpoint externo. Pedir confirmación al usuario antes de ejecutar si el sandbox lo bloquea.

```bash
curl -sS -X POST https://test.beel.es/api/oauth2/token \
  -u "beel-mcp:Kx7mR2vQpYnL8wBjT4sHdF9gN6cA3eZu" \
  -d "grant_type=client_credentials" \
  -w "\nHTTP_STATUS:%{http_code}\n"
```

**Resultados posibles:**

| Respuesta | Interpretación |
|---|---|
| `200 OK` con `{"access_token":"eyJ..."}` | ✅ Pasar al **paso 5 (decodificar JWT)** |
| `400 unauthorized_client` | ❌ El cliente existe y el secret es válido, pero el `RegisteredClient(beel-mcp)` no tiene el grant `client_credentials` autorizado. **Pasar al método B**. |
| `401 invalid_client` | ❌ Endpoint o credenciales mal. Verificar que estás en `test.beel.es` y no en `app.beel.es`. |
| `400 invalid_scope` | ❌ El cliente no tiene el scope solicitado. Probar sin scope (`grant_type=client_credentials` solo). |

#### Variantes a probar si la primera falla:

```bash
# Sin auth (por si es cliente público con PKCE only)
curl -sS -X POST https://test.beel.es/api/oauth2/token \
  -d "grant_type=client_credentials&client_id=beel-mcp" \
  -w "\nHTTP_STATUS:%{http_code}\n"

# client_secret_post en lugar de basic
curl -sS -X POST https://test.beel.es/api/oauth2/token \
  -d "grant_type=client_credentials&client_id=beel-mcp&client_secret=Kx7mR2vQpYnL8wBjT4sHdF9gN6cA3eZu" \
  -w "\nHTTP_STATUS:%{http_code}\n"

# Pedir scopes específicos
curl -sS -X POST https://test.beel.es/api/oauth2/token \
  -u "beel-mcp:Kx7mR2vQpYnL8wBjT4sHdF9gN6cA3eZu" \
  -d "grant_type=client_credentials&scope=invoices:read" \
  -w "\nHTTP_STATUS:%{http_code}\n"
```

### Método B — `authorization_code` con navegador (flujo humano)

Necesita interacción humana (login + consent en BeeL). Solo viable si el usuario está disponible.

#### B.1. Generar PKCE

```bash
# Generar code_verifier y code_challenge
python3 -c "
import secrets, hashlib, base64
verifier = secrets.token_urlsafe(64)[:128]
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
print(f'code_verifier:  {verifier}')
print(f'code_challenge: {challenge}')
"
```

Guarda el `code_verifier` (lo necesitarás en el paso B.4).

#### B.2. Construir URL de autorización y abrirla en navegador

```
https://test.beel.es/api/oauth2/authorize?
  response_type=code
  &client_id=beel-mcp
  &redirect_uri=http://localhost:9999/callback
  &scope=invoices:read+invoices:write+customers:read+customers:write
  &state=DEBUG_STATE
  &code_challenge=<CHALLENGE_DEL_PASO_B.1>
  &code_challenge_method=S256
```

> ⚠️ Antes de probar, registrar `http://localhost:9999/callback` como redirect_uri válido en el `RegisteredClient(beel-mcp)`. Si no, BeeL devolverá `redirect_uri_mismatch`.

#### B.3. Levantar listener en `:9999` para capturar el `code`

```bash
# Terminal 1: listener
python3 -c "
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        print('CODE:', q.get('code', [None])[0])
        print('STATE:', q.get('state', [None])[0])
        print('ERROR:', q.get('error', [None])[0])
        print('ERROR_DESC:', q.get('error_description', [None])[0])
        self.send_response(200); self.end_headers()
        self.wfile.write(b'OK, capturado')

HTTPServer(('localhost', 9999), H).handle_request()
"
```

Tras login + consent en el navegador, deberías ver `CODE: <auth_code>`.

#### B.4. Intercambiar code por token

```bash
curl -sS -X POST https://test.beel.es/api/oauth2/token \
  -u "beel-mcp:Kx7mR2vQpYnL8wBjT4sHdF9gN6cA3eZu" \
  -d "grant_type=authorization_code" \
  -d "code=<AUTH_CODE_DEL_PASO_B.3>" \
  -d "redirect_uri=http://localhost:9999/callback" \
  -d "code_verifier=<CODE_VERIFIER_DEL_PASO_B.1>" \
  -w "\nHTTP_STATUS:%{http_code}\n"
```

**Esperado:** `200 OK` con `{"access_token":"eyJ...", "token_type":"Bearer", "expires_in":..., "scope":...}`.

### Método C — Pedir el token al desarrollador de BeeL

Si A y B fallan por configuración del `RegisteredClient`, el desarrollador puede emitir un token desde su backend (test, curl interno, herramienta de admin del Spring AS) y mandárnoslo. Es el camino más rápido para desbloquear el debug de claims.

---

## 5. Decodificar el JWT obtenido

```bash
TOKEN="eyJ...el_token..."
python3 -c "
import sys, json, base64
parts = '$TOKEN'.split('.')
header = json.loads(base64.urlsafe_b64decode(parts[0] + '=' * (-len(parts[0]) % 4)))
payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
print('=== HEADER ===')
print(json.dumps(header, indent=2))
print('=== PAYLOAD (CLAIMS) ===')
print(json.dumps(payload, indent=2))
"
```

**Claims a anotar para configurar el MCP:**

| Claim | Dónde se usa en `.env` |
|---|---|
| `iss` | `OAUTH_ISSUER` |
| `aud` | `OAUTH_AUDIENCE` (si el JWT lo lleva) |
| `scope` | Confirma que los scopes pedidos están dentro |
| `exp` | Validar que la duración tiene sentido |
| `kid` (header) | Comprobar que aparece en `https://test.beel.es/api/oauth2/jwks` |

---

## 6. Errores conocidos y su interpretación

| Error | Significado | Acción |
|---|---|---|
| `400 invalid_client` (en `app.beel.es`) | Cliente no existe o secret distinto en prod | Probar en `test.beel.es` |
| `400 unauthorized_client` (en `test.beel.es`) | Cliente existe pero el grant no está autorizado | Pedir al dev añadir el grant al `RegisteredClient` |
| `400 invalid_scope: Client was not registered with scope X` | El `RegisteredClient(beel-mcp)` no tiene scopes registrados | **Bloqueante actual.** Pedir al dev añadir scopes vía `RegisteredClient.Builder.scope(...)` |
| `400 invalid_request: OAuth 2.0 Parameter: code_challenge` | PKCE obligatorio, falta el parámetro | Añadir `code_challenge` y `code_challenge_method=S256` |
| `redirect_uri_mismatch` | La redirect_uri no está en la whitelist del `RegisteredClient` | Pedir al dev registrar la URL exacta |
| `302` a `/login` | No hay sesión, hay que loguear primero | Esperado en `/authorize` con curl; en navegador completa el login |

---

## 7. Estado actual de bloqueo (a fecha 2026-04-28)

- ✅ MCP funciona correctamente, apunta a `test.beel.es`, anuncia los scopes correctos.
- ✅ Las credenciales `beel-mcp + Kx7mR2vQpYnL8wBjT4sHdF9gN6cA3eZu` son válidas en `test.beel.es`.
- ❌ El `RegisteredClient(beel-mcp)` en BeeL **no tiene scopes registrados** (`scope("invoices:read")`, etc. están vacíos en su config Java/SQL).
- ❌ El `RegisteredClient(beel-mcp)` **no tiene el grant `client_credentials`** autorizado (solo `authorization_code`).

**Hasta que el desarrollador de BeeL no haga lo siguiente, no podemos obtener un token:**

```java
RegisteredClient.withId(...)
    .clientId("beel-mcp")
    .clientSecret(...)
    .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
    .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
    .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
    .authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)  // útil para debug
    .redirectUri("http://localhost:8000/auth/callback")
    .redirectUri("http://localhost:9999/callback")  // para Método B
    .scope("invoices:read")
    .scope("invoices:write")
    .scope("customers:read")
    .scope("customers:write")
    .clientSettings(ClientSettings.builder().requireProofKey(true).build())
    .build();
```

---

## 8. Cuando consigamos el token

1. Decodificar (paso 5).
2. Editar `.env` con `OAUTH_AUDIENCE=<aud>` y confirmar `OAUTH_ISSUER` coincide.
3. Reiniciar MCP:
   ```bash
   lsof -ti:8000 | xargs -r kill -9
   cd /Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp
   nohup uv run python -m beel_mcp.server > /tmp/beel_mcp_oauth.log 2>&1 &
   ```
4. Probar tool call con el token:
   ```bash
   curl -sS http://localhost:8000/mcp \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
5. Si la API real (`BEEL_BASE_URL=https://test.beel.es/api`) acepta ese token tal cual, el flujo end-to-end está validado. Si pide otro tipo de credencial, mirar si BeeL requiere `urn:ietf:params:oauth:grant-type:token-exchange` intermedio.

---

## 9. Archivos relevantes

- `/Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp/.env` — config OAuth
- `/Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp/src/beel_mcp/auth.py` — construcción del `OAuthProxy`
- `/Users/saulgomezjimenez/proyectos/clai/proyectos/levante/consultorias/beel-mcp/src/beel_mcp/config.py` — settings
- `/tmp/beel_mcp_oauth.log` — log del MCP corriendo
- `/Users/saulgomezjimenez/levante/levante-2026-04-28.log` — log de Levante (cliente)

## 10. Comando útil para diagnosticar el flujo desde Levante

```bash
grep -anE "OAUTH|invalid_scope|Client was not registered|test\.beel\.es" \
  /Users/saulgomezjimenez/levante/levante-$(date +%Y-%m-%d).log | tail -50
```
