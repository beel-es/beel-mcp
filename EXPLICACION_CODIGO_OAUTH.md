# Qué código hay que meter y por qué — explicado de cero

---

## Primero: ¿qué tenemos ahora?

Nuestro MCP funciona así:

```
Tú le dices a Claude: "Crea una factura para Pepito"
         │
         ▼
   Claude se conecta al MCP Server (nuestro código)
         │
         ▼
   El MCP Server llama a la API de BeeL con una API Key fija
   que pusimos en el archivo .env:
         │
         POST https://app.beel.es/api/v1/invoices
         Authorization: Bearer beel_sk_test_abc123    ← siempre la misma
```

Esa API Key es como una contraseña que se mete en un archivo y nunca cambia.
Funciona, pero es como dejar la llave de casa debajo del felpudo.

---

## ¿Qué queremos conseguir?

Que en vez de usar una contraseña fija, **cada usuario inicie sesión con su cuenta de BeeL**, y el MCP use el token temporal de esa sesión.

```
Tú le dices a Claude: "Crea una factura para Pepito"
         │
         ▼
   Claude dice: "Necesitas iniciar sesión en BeeL"
   Se abre tu navegador → haces login en BeeL → vuelves
         │
         ▼
   El MCP Server llama a la API de BeeL con TU token temporal:
         │
         POST https://app.beel.es/api/v1/invoices
         Authorization: Bearer eyJhbG...tuTokenPersonal    ← cambia por usuario
```

---

## ¿Qué archivos tocamos?

Solo 5. Voy a explicar cada uno con el código exacto y por qué.

---

## Archivo 1: `config.py` — "La lista de configuración"

### ¿Qué hace este archivo?
Define qué variables de entorno necesita el servidor para arrancar. Es como un formulario: "para funcionar necesito estos datos".

### ¿Qué tiene ahora?

```python
beel_api_key: SecretStr = Field(alias="BEEL_API_KEY")
```

Esto dice: "necesito obligatoriamente una API Key de BeeL para arrancar".

### ¿Qué le añadimos?

```python
# La API Key ya no es obligatoria siempre — solo cuando no usas OAuth
beel_api_key: SecretStr | None = Field(default=None, alias="BEEL_API_KEY")

# Nuevo: interruptor para activar OAuth
oauth_enabled: bool = Field(default=False, alias="OAUTH_ENABLED")

# Nuevo: datos del OAuth de BeeL (solo necesarios si oauth_enabled=True)
oauth_authorization_endpoint: str | None = None   # ¿Dónde hace login el usuario?
oauth_token_endpoint: str | None = None            # ¿Dónde se pide el token?
oauth_client_id: str | None = None                 # ¿Quiénes somos nosotros ante BeeL?
oauth_client_secret: SecretStr | None = None       # Nuestra contraseña ante BeeL
oauth_jwks_uri: str | None = None                  # ¿Cómo verificamos que el token es real?
oauth_audience: str | None = None                  # ¿Para qué API es el token?
mcp_public_url: str | None = None                  # ¿En qué URL está nuestro MCP?
```

### ¿Por qué?

Porque el servidor necesita saber **dónde está el OAuth de BeeL** para poder redirigir al usuario allí. Es como decirle al servidor: "cuando alguien quiera entrar, mándalo a esta dirección para que haga login".

### También añadimos una validación:

```python
# Si no usas OAuth → necesitas API Key (como ahora)
# Si usas OAuth → necesitas los datos de OAuth
```

Esto evita que alguien arranque el servidor sin configurar ni una cosa ni la otra.

---

## Archivo 2: `beel_client.py` — "El que habla con BeeL"

### ¿Qué hace este archivo?
Es el código que envía las peticiones HTTP a la API de BeeL. Cuando un tool dice "crea una factura", este archivo es el que hace el `POST https://app.beel.es/api/v1/invoices`.

### ¿Qué tiene ahora?

```python
class BeelClient:
    def __init__(self, settings):
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": settings.authorization_header,  # ← API Key fija
            }
        )
```

La API Key se mete en el cliente HTTP cuando se crea, y **todas las peticiones** usan esa misma key. Es como comprar un abono de autobús: siempre el mismo billete.

### ¿Qué cambiamos?

Añadimos un parámetro opcional llamado `token_resolver`. Es una función que, cuando la llamas, te devuelve el token del usuario que está usando el MCP en ese momento.

```python
class BeelClient:
    def __init__(self, settings, *, token_resolver=None):
        self._token_resolver = token_resolver    # ← nuevo
        self._client = httpx.AsyncClient(
            headers={
                "Accept": "application/json",    # ← ya no metemos Authorization aquí
            }
        )
```

Y en el método interno `_request` (que es el que envía cada petición):

```python
async def _request(self, method, path, ...):
    headers = ...

    # ¿Cómo decidimos qué Authorization mandar?
    if self._token_resolver:
        # MODO OAUTH: preguntamos "¿quién es el usuario actual?"
        token = self._token_resolver()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    elif self._settings.authorization_header:
        # MODO API KEY: usamos la key fija de siempre
        headers["Authorization"] = self._settings.authorization_header

    # ... el resto sigue igual, no cambia nada ...
```

### ¿Por qué?

Antes era como un restaurante con una sola cuenta para todos. Ahora cada comensal paga con su propia tarjeta. El `token_resolver` es el camarero que pregunta "¿con qué tarjeta paga usted?" en cada petición.

### ¿Se tocan los métodos como `list_customers`, `create_invoice`, etc.?

**No.** Todos siguen exactamente igual. El cambio está solo en `_request`, que es el método interno que todos usan por debajo. Es como cambiar el motor de un coche sin tocar el volante ni los pedales.

---

## Archivo 3: `server.py` — "El punto de entrada"

### ¿Qué hace este archivo?
Crea el servidor MCP, inicializa los servicios, y registra los tools.

### ¿Qué tiene ahora?

```python
mcp = FastMCP(
    name="BeeL MCP Server",
    lifespan=lifespan,    # ← sin autenticación
)
```

El servidor arranca "abierto" — quien se conecte, puede usarlo.

### ¿Qué cambiamos?

Dos cosas:

**A) Crear el OAuthProxy si OAuth está activado:**

```python
settings = get_settings()
auth = None

if settings.oauth_enabled:
    from fastmcp.server.auth import OAuthProxy
    from fastmcp.server.auth.providers.jwt import JWTVerifier

    auth = OAuthProxy(
        # Le decimos: "el login de BeeL está aquí"
        upstream_authorization_endpoint=settings.oauth_authorization_endpoint,
        # "Y los tokens se piden aquí"
        upstream_token_endpoint=settings.oauth_token_endpoint,
        # "Nosotros somos esta app registrada en BeeL"
        upstream_client_id=settings.oauth_client_id,
        upstream_client_secret=...,
        # "Para verificar que un token es válido, usa estas claves públicas"
        token_verifier=JWTVerifier(
            jwks_uri=settings.oauth_jwks_uri,
            audience=settings.oauth_audience,
        ),
        # "Nuestro servidor está en esta URL"
        base_url=settings.mcp_public_url,
    )

mcp = FastMCP(
    name="BeeL MCP Server",
    auth=auth,          # ← Si auth=None, funciona como ahora (sin auth)
    lifespan=lifespan,  #   Si auth=OAuthProxy, pide login
)
```

**¿Qué hace el `OAuthProxy`?**

FastMCP ya trae todo el código para manejar OAuth. El `OAuthProxy` hace automáticamente:

1. Cuando alguien se conecta sin token → responde "401, necesitas autenticarte"
2. El cliente MCP (Claude) ve el 401 y pregunta "¿dónde me autentico?"
3. El OAuthProxy responde "en esta URL de BeeL"
4. Claude abre el navegador, el usuario hace login en BeeL
5. BeeL redirige de vuelta al MCP con un código temporal
6. El OAuthProxy intercambia ese código por un token
7. A partir de ahí, cada petición viene con el token del usuario

**Nosotros no escribimos nada de esa lógica.** Solo le decimos "el OAuth de BeeL está en estas URLs" y FastMCP hace todo lo demás.

**B) Pasar el `token_resolver` al BeelClient:**

```python
@asynccontextmanager
async def lifespan(_: FastMCP):
    settings = get_settings()

    token_resolver = None
    if settings.oauth_enabled:
        from fastmcp.server.dependencies import get_access_token

        def token_resolver():
            t = get_access_token()     # ← "¿Quién es el usuario actual?"
            return t.token if t else None  # ← "Dame su token"

    beel_client = BeelClient(settings, token_resolver=token_resolver)
    # ... el resto sigue igual ...
```

**¿Qué es `get_access_token()`?**

Es una función de FastMCP. Cuando un usuario hace una petición al MCP (ej: "busca facturas"), FastMCP sabe quién es ese usuario porque ya validó su token. `get_access_token()` te da ese token.

Entonces el flujo completo es:
1. El usuario ya hizo login → Claude manda el token con cada petición
2. FastMCP valida el token automáticamente
3. Nuestro tool se ejecuta → llama al service → llama a BeelClient
4. BeelClient llama a `token_resolver()` → que llama a `get_access_token()`
5. Obtenemos el token del usuario y lo reenviamos a BeeL

**Es como un pase de manos:** Claude recibe el token → se lo pasa al MCP → el MCP se lo pasa a BeeL. Nadie genera tokens nuevos, solo se reenvía el que ya existe.

---

## Archivo 4: `.env.example` — "La plantilla de configuración"

Solo se añaden las variables nuevas con comentarios explicativos:

```bash
# === Modo actual (API Key, para desarrollo local) ===
BEEL_API_KEY=beel_sk_test_xxxxxxxxxxxxxxxxxxxx
# ... las demás siguen igual ...

# === OAuth (para producción con login de usuario) ===
OAUTH_ENABLED=false
OAUTH_AUTHORIZATION_ENDPOINT=https://app.beel.es/oauth/authorize
OAUTH_TOKEN_ENDPOINT=https://app.beel.es/oauth/token
OAUTH_CLIENT_ID=tu-client-id-aqui
OAUTH_CLIENT_SECRET=tu-client-secret-aqui
OAUTH_JWKS_URI=https://app.beel.es/.well-known/jwks.json
OAUTH_AUDIENCE=https://app.beel.es/api
MCP_PUBLIC_URL=https://tu-mcp-server.com
```

---

## Archivo 5: `tests/conftest.py` — "Los tests"

Cambio mínimo: como `beel_api_key` ahora es opcional, nos aseguramos de que el mock siga pasando un valor (porque los tests usan modo API Key):

```python
Settings(
    BEEL_API_KEY="beel_sk_test_fake123",
    OAUTH_ENABLED=False,   # ← explícito: tests usan API Key
    ...
)
```

Los tests existentes no cambian de comportamiento. No hay que escribir tests nuevos obligatoriamente.

---

## Resumen visual

```
                         ANTES
                    ┌──────────────┐
                    │   .env       │
                    │ API_KEY=abc  │──────────────────────────┐
                    └──────────────┘                          │
                                                             ▼
Claude ──stdio──► server.py ──► tools ──► services ──► beel_client.py ──► BeeL API
                  (sin auth)                            (API Key fija)


                        DESPUÉS
                    ┌──────────────┐
                    │   .env       │
                    │ OAUTH_*=...  │──────┐
                    └──────────────┘      │
                                          ▼
Claude ──HTTP──► server.py ──► tools ──► services ──► beel_client.py ──► BeeL API
                 (OAuthProxy)                         (token del usuario)
                      │
                      ▼
               BeeL OAuth Login
              (el usuario hace login
               en su navegador)
```

---

## Lo que NO escribimos nosotros

Esto es importante: **el 90% del trabajo lo hace FastMCP automáticamente.** Nosotros solo:

| Lo que hacemos | Líneas de código | Lo que FastMCP hace por nosotros |
|----------------|:---:|----------------------------------|
| Decirle dónde está el OAuth de BeeL | ~15 | Manejar todo el flujo de login, callbacks, tokens, validación, discovery |
| Añadir `token_resolver` al client | ~10 | Inyectar el token del usuario en el contexto de cada petición |
| Variables de configuración | ~10 | Servir los endpoints `/.well-known/*` que la spec MCP requiere |
| Validación de config | ~10 | Dynamic Client Registration, PKCE, refresh tokens |

Total nuestro: **~45 líneas de código real.** El resto es FastMCP.
