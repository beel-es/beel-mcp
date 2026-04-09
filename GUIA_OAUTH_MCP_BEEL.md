# Guía: Cómo funciona OAuth con MCP y BeeL

> Guía pensada para alguien que no tiene experiencia previa con OAuth.

---

## 1. El problema que resuelve OAuth

### Sin OAuth (como funciona ahora)

Ahora mismo, para usar el MCP de BeeL, necesitas poner una **API Key** (una contraseña larga) en un archivo `.env` en tu ordenador:

```
BEEL_API_KEY=beel_sk_live_abc123xyz...
```

Esto tiene varios problemas:

- Si alguien ve esa clave, puede usarla para hacer cualquier cosa en tu cuenta de BeeL
- La clave no caduca (a menos que la revoques manualmente)
- Si quieres que varias personas usen el MCP, tienes que compartir la clave o crear una por persona
- No hay forma de limitar qué puede hacer cada persona

### Con OAuth

En vez de copiar y pegar una clave secreta, el usuario **inicia sesión directamente en BeeL** (como cuando haces "Iniciar sesión con Google" en una web). BeeL te da un **token temporal** que caduca solo y que puede tener permisos limitados.

---

## 2. Analogía: El hotel

Imagina que BeeL es un hotel:

| Concepto | Sin OAuth | Con OAuth |
|----------|-----------|-----------|
| Acceso | Te dan una **copia de la llave maestra**. Abre todo, para siempre. | Vas a recepción, te identificas, y te dan una **tarjeta de habitación** que solo abre tu habitación y caduca cuando haces checkout. |
| Si la pierdes | Quien la encuentre tiene acceso a todo | La tarjeta caduca sola. Además, puedes ir a recepción y anularla |
| Compartir | Copias la llave y la mandas por WhatsApp | Cada persona va a recepción y recibe su propia tarjeta |

---

## 3. Los actores del flujo OAuth

En nuestro caso hay **4 actores**:

```
┌──────────────┐
│   USUARIO    │  Tú, la persona que quiere usar BeeL
│   (Tú)       │  desde Claude u otro asistente AI
└──────┬───────┘
       │ 1. "Quiero usar BeeL"
       ▼
┌──────────────┐
│   CLIENTE    │  Claude Desktop, Cursor, o cualquier
│   MCP        │  app que se conecta al MCP Server
└──────┬───────┘
       │ 2. "Ok, necesitas autenticarte con BeeL"
       ▼
┌──────────────┐
│   SERVIDOR   │  Nuestro código: el MCP Server de BeeL
│   MCP        │  (lo que hemos construido en este proyecto)
└──────┬───────┘
       │ 3. "Te redirijo a BeeL para que inicies sesión"
       ▼
┌──────────────┐
│   BeeL       │  El servidor de BeeL, que tiene tus datos
│   (OAuth     │  de facturación. Él verifica tu identidad
│   Provider)  │  y da el permiso
└──────────────┘
```

---

## 4. El flujo paso a paso

Esto es lo que pasa cuando un usuario quiere usar el MCP con OAuth:

### Paso 1 — El usuario intenta usar una herramienta

El usuario le dice a Claude: *"Crea una factura para el cliente X"*

Claude intenta conectarse al MCP Server. Como el MCP Server tiene OAuth activado, responde: **"401 — No estás autenticado"**.

### Paso 2 — El cliente MCP descubre cómo autenticarse

El cliente MCP (Claude Desktop) pregunta al servidor:
> "¿Dónde me autentico?"

Lo hace visitando una URL especial:
```
GET https://tu-mcp-server.com/.well-known/oauth-protected-resource
```

El servidor responde:
```json
{
  "authorization_server": "https://app.beel.es/oauth"
}
```

### Paso 3 — Se abre el navegador

El cliente MCP abre tu **navegador** con la página de login de BeeL:

```
https://app.beel.es/oauth/authorize?
  client_id=mcp-beel-server&
  redirect_uri=https://tu-mcp-server.com/auth/callback&
  response_type=code&
  scope=invoices:read invoices:write customers:read
```

Verás algo así en tu navegador:

```
┌─────────────────────────────────────────┐
│                                         │
│            🔑 BeeL Login               │
│                                         │
│   Email:    [________________]          │
│   Password: [________________]          │
│                                         │
│   La aplicación "BeeL MCP Server"       │
│   solicita acceso a:                    │
│                                         │
│   ✓ Leer facturas                       │
│   ✓ Crear y editar facturas             │
│   ✓ Leer clientes                       │
│                                         │
│   [ Cancelar ]    [ Autorizar ]         │
│                                         │
└─────────────────────────────────────────┘
```

### Paso 4 — BeeL da un código temporal

Si haces clic en **"Autorizar"**, BeeL redirige tu navegador a:

```
https://tu-mcp-server.com/auth/callback?code=abc123temporal
```

Este `code` es de un solo uso y caduca en segundos.

### Paso 5 — El MCP Server intercambia el código por un token

Nuestro MCP Server, **en segundo plano** (sin que tú veas nada), envía ese código a BeeL:

```
POST https://app.beel.es/oauth/token
{
  "grant_type": "authorization_code",
  "code": "abc123temporal",
  "client_id": "mcp-beel-server",
  "client_secret": "secreto-del-servidor"
}
```

BeeL responde con un **access token** (la "tarjeta de habitación"):

```json
{
  "access_token": "eyJhbGci...token-largo...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh_abc123..."
}
```

### Paso 6 — Todo funciona

A partir de ahora, cada vez que el MCP Server necesite hablar con BeeL, usa ese token:

```
GET https://app.beel.es/api/invoices
Authorization: Bearer eyJhbGci...token-largo...
```

El usuario no tiene que hacer nada más. Cuando el token caduca (ej: 1 hora), el MCP Server usa el `refresh_token` para obtener uno nuevo automáticamente.

### Diagrama completo del flujo

```
  Usuario          Claude/Cursor       MCP Server            BeeL
     │                  │                  │                    │
     │  "Crea factura"  │                  │                    │
     │─────────────────>│                  │                    │
     │                  │  Conecta al MCP  │                    │
     │                  │─────────────────>│                    │
     │                  │    401 No auth   │                    │
     │                  │<─────────────────│                    │
     │                  │                  │                    │
     │  Abre navegador  │  Descubre OAuth  │                    │
     │<─────────────────│─────────────────>│                    │
     │                  │                  │                    │
     │  Login en BeeL ──────────────────────────────────────>  │
     │                  │                  │                    │
     │  "Autorizar" ────────────────────────────────────────>  │
     │                  │                  │                    │
     │                  │     code=abc123  │                    │
     │  Redirect ───────────────────────> │                    │
     │                  │                  │                    │
     │                  │                  │  Intercambia code  │
     │                  │                  │───────────────────>│
     │                  │                  │  access_token      │
     │                  │                  │<───────────────────│
     │                  │                  │                    │
     │                  │  Reconecta       │                    │
     │                  │─────────────────>│                    │
     │                  │  200 OK          │  GET /invoices     │
     │                  │<─────────────────│───────────────────>│
     │                  │                  │  Datos factura     │
     │  "Factura creada"│                  │<───────────────────│
     │<─────────────────│                  │                    │
```

---

## 5. ¿Qué cambia para el usuario final?

| Aspecto | Ahora (API Key) | Con OAuth |
|---------|-----------------|-----------|
| **Setup inicial** | Copiar API Key al archivo `.env` | La primera vez: iniciar sesión en BeeL desde el navegador |
| **Uso diario** | Nada, funciona automáticamente | Nada, funciona automáticamente. Si el token caduca, se renueva solo |
| **Seguridad** | Si alguien accede a tu `.env`, tiene acceso total | Los tokens caducan solos. Se pueden revocar desde BeeL |
| **Multi-usuario** | Cada persona necesita una API Key | Cada persona inicia sesión con su cuenta de BeeL |
| **Permisos** | La API Key tiene acceso a todo | Se pueden limitar permisos (ej: solo lectura) |

---

## 6. ¿Qué tendríamos que hacer nosotros?

### 6.1 Información que necesitamos de BeeL

Antes de tocar código, necesitamos que el equipo de BeeL nos proporcione:

| Dato | Qué es | Ejemplo |
|------|--------|---------|
| **Authorization endpoint** | URL donde el usuario inicia sesión | `https://app.beel.es/oauth/authorize` |
| **Token endpoint** | URL donde se intercambia el código por token | `https://app.beel.es/oauth/token` |
| **Client ID** | Identificador de nuestra app registrada en BeeL | `mcp-beel-server-prod` |
| **Client Secret** | Contraseña de nuestra app (la guarda el servidor, nunca el usuario) | `beel_oauth_secret_xyz...` |
| **JWKS URI** (si usan JWT) | URL para verificar la firma de los tokens | `https://app.beel.es/.well-known/jwks.json` |
| **Scopes disponibles** | Qué permisos se pueden pedir | `invoices:read`, `invoices:write`, `customers:read` |
| **Documentación OAuth** | Guía de su implementación OAuth | URL a sus docs |

### 6.2 Lo que tendríamos que cambiar en nuestro código

Son **cambios localizados** en pocos archivos:

#### Archivo 1: `config.py` — Añadir settings de OAuth

```python
# Nuevas variables de entorno (se añaden a las existentes)
OAUTH_ENABLED: bool = False
OAUTH_AUTHORIZATION_ENDPOINT: str | None = None
OAUTH_TOKEN_ENDPOINT: str | None = None
OAUTH_CLIENT_ID: str | None = None
OAUTH_CLIENT_SECRET: str | None = None
OAUTH_JWKS_URI: str | None = None
OAUTH_AUDIENCE: str | None = None
MCP_PUBLIC_URL: str | None = None  # URL pública del MCP Server
```

#### Archivo 2: `server.py` — Activar OAuth

```python
# Antes (sin OAuth):
mcp = FastMCP(name="BeeL MCP Server", lifespan=lifespan)

# Después (con OAuth):
if settings.OAUTH_ENABLED:
    from fastmcp.server.auth import OAuthProxy
    from fastmcp.server.auth.providers.jwt import JWTVerifier

    auth = OAuthProxy(
        upstream_authorization_endpoint=settings.OAUTH_AUTHORIZATION_ENDPOINT,
        upstream_token_endpoint=settings.OAUTH_TOKEN_ENDPOINT,
        upstream_client_id=settings.OAUTH_CLIENT_ID,
        upstream_client_secret=settings.OAUTH_CLIENT_SECRET,
        token_verifier=JWTVerifier(
            jwks_uri=settings.OAUTH_JWKS_URI,
            audience=settings.OAUTH_AUDIENCE,
        ),
        base_url=settings.MCP_PUBLIC_URL,
    )
else:
    auth = None

mcp = FastMCP(name="BeeL MCP Server", auth=auth, lifespan=lifespan)
```

#### Archivo 3: `.env` — Configuración

```bash
# Modo actual (API Key, para desarrollo local):
OAUTH_ENABLED=false
BEEL_API_KEY=beel_sk_live_abc123...

# Modo OAuth (para producción/multi-usuario):
OAUTH_ENABLED=true
OAUTH_AUTHORIZATION_ENDPOINT=https://app.beel.es/oauth/authorize
OAUTH_TOKEN_ENDPOINT=https://app.beel.es/oauth/token
OAUTH_CLIENT_ID=mcp-beel-server
OAUTH_CLIENT_SECRET=secreto_aqui
OAUTH_JWKS_URI=https://app.beel.es/.well-known/jwks.json
OAUTH_AUDIENCE=https://app.beel.es/api
MCP_PUBLIC_URL=https://tu-mcp-server.com
```

#### Archivo 4: `fastmcp.json` — Cambiar transporte

```json
// Antes (local):
{ "transport": "stdio" }

// Después (remoto con OAuth):
{ "transport": "streamable-http", "host": "0.0.0.0", "port": 8000 }
```

#### Archivo 5: `beel_client.py` — Usar token OAuth en vez de API Key

Actualmente, `BeelClient` siempre usa la API Key fija del `.env`. Con OAuth, el token viene del flujo de autenticación y se pasa al cliente dinámicamente. Este es el cambio más técnico, pero FastMCP gestiona la mayoría automáticamente.

### 6.3 Requisito importante: despliegue HTTP

OAuth **no funciona en modo local (stdio)**. El MCP Server necesita estar accesible por internet para que:

1. BeeL pueda redirigir al usuario de vuelta (el callback)
2. Claude Desktop / Cursor pueda conectarse por HTTP

Opciones de despliegue:

| Opción | Coste | Dificultad |
|--------|-------|------------|
| **Railway / Render / Fly.io** | ~5-10 $/mes | Baja |
| **VPS (DigitalOcean, Hetzner)** | ~5 $/mes | Media |
| **Docker en servidor propio** | Variable | Media-Alta |

---

## 7. Próximos pasos concretos

```
 1. ☐ Pedir a BeeL la documentación de su OAuth
       → Endpoints, cómo registrar la app, scopes disponibles

 2. ☐ Registrar nuestra app OAuth en BeeL
       → Nos darán Client ID y Client Secret

 3. ☐ Decidir dónde desplegar el MCP Server
       → Necesitamos una URL pública (ej: https://beel-mcp.tudominio.com)

 4. ☐ Implementar los cambios en el código
       → ~4-5 archivos, cambios pequeños y localizados

 5. ☐ Probar el flujo completo
       → Conectar Claude Desktop al MCP por HTTP, verificar login

 6. ☐ Opcional: mantener modo API Key como fallback
       → Para desarrollo local sin necesidad de OAuth
```

---

## 8. Preguntas frecuentes

### ¿El usuario tiene que hacer login cada vez que usa Claude?

**No.** Solo la primera vez (o cuando el token expire y no se pueda renovar). Los tokens suelen durar horas o días, y el `refresh_token` permite renovarlos sin volver a hacer login.

### ¿Se puede usar OAuth en local (mi ordenador)?

**No directamente.** OAuth necesita una URL pública para el callback. Pero se puede:
- Usar `ngrok` o `cloudflared` para crear un túnel temporal (para pruebas)
- Mantener el modo API Key para desarrollo local

### ¿Qué pasa si BeeL usa tokens opacos en vez de JWT?

FastMCP soporta ambos. Si los tokens no son JWT, se usa `IntrospectionTokenVerifier` en vez de `JWTVerifier`:

```python
from fastmcp.server.auth.token_verification import IntrospectionTokenVerifier

token_verifier = IntrospectionTokenVerifier(
    introspection_endpoint="https://app.beel.es/oauth/introspect",
    client_id="mcp-beel-server",
    client_secret="secreto",
)
```

### ¿OAuth reemplaza la API Key?

**Depende de cómo lo implemente BeeL.** Lo más probable es que:
- El token OAuth **reemplace** la API Key en las peticiones a la API
- O bien, el MCP Server use el token OAuth para identificar al usuario y luego use una API Key interna

Esto lo sabremos cuando veamos su documentación OAuth.

### ¿Puedo tener ambos modos (API Key y OAuth)?

**Sí.** El código está pensado para que `OAUTH_ENABLED=false` use API Key (modo actual) y `OAUTH_ENABLED=true` active OAuth. No se rompe nada.
