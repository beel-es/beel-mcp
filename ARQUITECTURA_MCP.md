# Arquitectura del MCP Server de BeeL — Guia completa

> Fecha: 2026-04-09
> Estado: implementacion completada y tests pasando (7/7)

## 1. Que es este proyecto

Este es un **servidor MCP (Model Context Protocol)** que permite a agentes de IA (Claude Desktop, Claude Code, Cursor, etc.) operar la API de facturacion de **BeeL** mediante lenguaje natural. El agente puede buscar clientes, crear facturas, emitirlas, enviarlas por email, consultar VeriFactu y exportar datos — todo con guardrails fiscales que impiden acciones peligrosas sin confirmacion explicita.

**Stack tecnologico:**
- Python >= 3.11
- FastMCP v3 (framework para servidores MCP)
- httpx (cliente HTTP asincrono)
- Pydantic v2 (validacion de datos)
- pydantic-settings (configuracion por variables de entorno)

---

## 2. Estructura del proyecto

```
beel-mcp/
├── pyproject.toml                  # Dependencias y metadatos del proyecto
├── fastmcp.json                    # Configuracion de despliegue FastMCP
├── .env.example                    # Plantilla de variables de entorno
├── beel-api-openapi (2).yaml       # Especificacion OpenAPI de BeeL (referencia)
│
├── src/beel_mcp/
│   ├── __init__.py                 # Paquete raiz
│   ├── server.py                   # Punto de entrada: arranca el servidor y registra tools
│   ├── config.py                   # Configuracion (API key, URLs, timeouts)
│   ├── schemas.py                  # Modelos Pydantic de entrada/salida
│   ├── runtime.py                  # Helpers para construir respuestas de tools
│   │
│   ├── client/                     # Capa HTTP contra la API de BeeL
│   │   ├── __init__.py
│   │   ├── beel_client.py          # Cliente HTTP con reintentos e idempotencia
│   │   ├── exceptions.py           # Jerarquia de errores tipados
│   │   └── idempotency.py          # Generador de claves de idempotencia
│   │
│   ├── services/                   # Logica de negocio por dominio
│   │   ├── __init__.py
│   │   ├── customer_service.py     # Buscar, crear, actualizar clientes
│   │   ├── nif_service.py          # Validar NIF contra AEAT
│   │   ├── invoice_service.py      # CRUD de facturas + validacion de estado
│   │   ├── pdf_service.py          # Preview y descarga de PDFs
│   │   ├── delivery_service.py     # Envio de facturas por email
│   │   ├── verifactu_service.py    # Consulta de estado VeriFactu
│   │   └── export_service.py       # Exportacion a Excel
│   │
│   ├── policies/                   # Guardrails y reglas de negocio
│   │   ├── __init__.py
│   │   ├── state_machine.py        # Que acciones se permiten en cada estado
│   │   ├── nif_policy.py           # Politica de validacion de NIF
│   │   └── confirmations.py        # Acciones que requieren confirmacion explicita
│   │
│   └── tools/                      # Las 17 tools MCP expuestas al agente
│       ├── __init__.py
│       ├── customer_tools.py       # search_customers, create_customer, upsert_customer
│       ├── nif_tools.py            # validate_nif
│       ├── invoice_tools.py        # create_invoice_draft, update_invoice_draft, issue_invoice
│       ├── pdf_tools.py            # preview_invoice_pdf, get_invoice_pdf_download
│       ├── delivery_tools.py       # send_invoice_email
│       ├── payment_tools.py        # mark_invoice_paid
│       ├── status_tools.py         # get_invoice_status, get_verifactu_status
│       ├── export_tools.py         # export_invoices_excel
│       └── workflow_tools.py       # 3 workflows compuestos
│
└── tests/
    ├── conftest.py                 # Fixtures compartidos
    ├── test_client.py              # Test de reintentos e idempotencia
    ├── test_customer_service.py    # Test de busqueda/actualizacion de clientes
    └── test_policies.py            # Test de maquina de estados y politica NIF
```

---

## 3. Arquitectura por capas

El servidor tiene 5 capas bien separadas. Cada capa solo habla con la de abajo:

```
┌─────────────────────────────────────────────┐
│  TOOLS (tools/)                             │  ← Lo que el agente de IA llama
│  Funciones async que reciben parametros     │
│  simples y devuelven dict                   │
├─────────────────────────────────────────────┤
│  POLICIES (policies/)                       │  ← Guardrails que bloquean acciones
│  State machine, confirmaciones, NIF policy  │
├─────────────────────────────────────────────┤
│  SERVICES (services/)                       │  ← Logica de negocio
│  Orquestan llamadas al client y aplican     │
│  validaciones de dominio                    │
├─────────────────────────────────────────────┤
│  CLIENT (client/)                           │  ← Capa HTTP pura
│  beel_client.py con reintentos,             │
│  idempotencia y mapeo de errores            │
├─────────────────────────────────────────────┤
│  CONFIG + SCHEMAS + RUNTIME                 │  ← Infraestructura transversal
│  Configuracion, modelos Pydantic,           │
│  constructores de respuesta                 │
└─────────────────────────────────────────────┘
```

**Flujo tipico de una llamada:**

```
Agente IA
  → llama tool `issue_invoice(invoice_id, confirm=True)`
    → tool verifica confirmacion (policies/confirmations.py)
    → tool pide al service que emita (services/invoice_service.py)
      → service consulta estado actual de la factura
      → service valida con state_machine que esta en DRAFT
      → service llama a client.issue_invoice()
        → client hace POST /v1/invoices/{id}/issue con reintentos
    → tool construye respuesta con success_response() (runtime.py)
  → agente recibe dict con resultado estructurado
```

---

## 4. Explicacion archivo por archivo

### 4.1 Archivos de configuracion raiz

#### `pyproject.toml`
Define el proyecto Python: nombre, version, dependencias (`fastmcp`, `httpx`, `pydantic`, `pydantic-settings`) y dependencias de desarrollo (`pytest`, `respx`, `ruff`). El entry point `beel-mcp` apunta a `beel_mcp.server:main`.

#### `fastmcp.json`
Configuracion para que FastMCP sepa como arrancar el servidor: ruta al objeto `mcp` en `server.py`, entorno `uv`, transporte `stdio` y nivel de log `INFO`. Este archivo es lo que usan los clientes MCP (Claude Desktop, etc.) para instalar el servidor.

#### `.env.example`
Plantilla con todas las variables de entorno necesarias:
- `BEEL_API_KEY` — clave de API de BeeL (obligatoria)
- `BEEL_BASE_URL` — URL base de la API (por defecto `https://app.beel.es/api`)
- `BEEL_ENVIRONMENT` — `sandbox` o `production`
- `BEEL_TIMEOUT_SECONDS`, `BEEL_MAX_RETRIES`, `BEEL_RETRY_BACKOFF_SECONDS` — control de red
- `BEEL_MAX_INLINE_BINARY_BYTES` — limite para inlinear PDFs/Excel en la respuesta

---

### 4.2 `server.py` — Punto de entrada

**Para que sirve:** Es el archivo que arranca todo. Hace tres cosas:

1. **Define el `lifespan`:** Un context manager asincrono que al arrancar crea el `BeelClient` y todos los servicios, y los pone en un diccionario compartido. Cuando el servidor se cierra, libera el cliente HTTP.

2. **Crea el objeto `mcp`:** Una instancia de `FastMCP` con nombre, instrucciones para el agente y el lifespan.

3. **Registra las 17 tools:** Importa las funciones de cada modulo de `tools/` y las registra con `mcp.tool()`.

**Detalle clave:** Los servicios NO se crean como globales. Se crean dentro del `lifespan` y las tools los obtienen via `ctx.lifespan_context`. Esto evita problemas con import-time y tests.

---

### 4.3 `config.py` — Configuracion

**Para que sirve:** Define la clase `Settings` con todas las variables de entorno usando `pydantic-settings`. La funcion `get_settings()` con `@lru_cache` garantiza que la configuracion se lee una sola vez.

**Detalles relevantes:**
- La API key se guarda como `SecretStr` para que no aparezca en logs
- `authorization_header` genera el header `Bearer {key}` dinamicamente
- La base URL se normaliza quitando trailing slashes
- BeeL usa la misma URL para sandbox y produccion; la diferencia la marca el prefijo de la key (`beel_sk_test_` vs `beel_sk_live_`)

---

### 4.4 `schemas.py` — Modelos de datos

**Para que sirve:** Define todos los modelos Pydantic que validan los datos de entrada y salida. Cada modelo tiene un metodo `to_api_payload()` que transforma el modelo al formato exacto que espera la API de BeeL.

**Modelos principales:**

| Modelo | Para que se usa |
|--------|-----------------|
| `ToolResponse` | Estructura estandar de respuesta de todas las tools |
| `AddressInput` | Direccion fiscal de un cliente |
| `AlternativeIdInput` | Identificador alternativo al NIF (pasaporte, etc.) |
| `PaymentInfoInput` | Metodo de pago (transferencia, tarjeta, etc.) |
| `CreateCustomerInput` | Datos para crear un cliente (con validacion NIF vs alternative_id) |
| `UpdateCustomerInput` | Datos parciales para actualizar un cliente |
| `InvoiceLineInput` | Una linea de factura (descripcion, cantidad, precio, impuestos) |
| `RecipientInput` | Destinatario: o un `customer_id` existente o datos ad-hoc |
| `CreateInvoiceInput` | Datos completos para crear una factura borrador |
| `UpdateInvoiceInput` | Datos parciales para actualizar un borrador |

**Validaciones destacadas:**
- `CreateCustomerInput`: obliga a informar `nif` o `alternative_id`, pero no ambos
- `RecipientInput`: obliga a usar `customer_id` o datos ad-hoc, pero no ambos
- `CreateInvoiceInput`: si es CORRECTIVE exige `rectified_invoice_id` y `rectification_reason`
- `CreateInvoiceInput`: si es ad-hoc y no SIMPLIFIED, exige NIF y direccion

---

### 4.5 `runtime.py` — Helpers de respuesta

**Para que sirve:** Funciones auxiliares que usan todas las tools para construir respuestas estandarizadas.

**Funciones:**

- `get_from_lifespan(ctx, key)` — Saca un servicio del contexto de lifespan. Si no existe, lanza error claro.
- `get_settings_from_ctx(ctx)` — Atajo para obtener la configuracion.
- `success_response(...)` — Construye un `ToolResponse` exitoso con `action_taken`, `human_summary`, `data`, etc.
- `error_response(...)` — Construye un `ToolResponse` de error.
- `confirmation_required_response(...)` — Construye una respuesta que le dice al agente "necesitas confirmar antes de ejecutar esto".
- `inline_binary_result(data, ...)` — Decide si un binario (PDF/Excel) se inlinea como base64 o solo se devuelven metadatos. Si supera `BEEL_MAX_INLINE_BINARY_BYTES`, no se inlinea.

---

### 4.6 `client/beel_client.py` — Cliente HTTP

**Para que sirve:** Abstrae toda la comunicacion HTTP con la API de BeeL. Cada endpoint de la API tiene un metodo dedicado.

**Capacidades:**

1. **Reintentos con backoff exponencial:** Si la API devuelve 429 (rate limit) o 5xx (error de servidor), o si hay timeout de red, reintenta automaticamente hasta `BEEL_MAX_RETRIES` veces. La espera entre reintentos crece exponencialmente. Si la API manda header `Retry-After`, lo respeta.

2. **Idempotencia:** Los POSTs que crean recursos (facturas, clientes) generan un `Idempotency-Key` UUID que se mantiene estable durante todos los reintentos del mismo request. Esto evita crear facturas duplicadas si un retry tiene exito despues de que el primero ya habia creado el recurso.

3. **Mapeo de errores:** Cada status code HTTP se mapea a una excepcion tipada (400 → `BeelBadRequestError`, 404 → `BeelNotFoundError`, etc.). Todas incluyen `status_code`, `code`, `message`, `details` y `request_id`.

**Metodos disponibles:**

| Metodo | Endpoint BeeL |
|--------|---------------|
| `list_customers(**params)` | `GET /v1/customers` |
| `get_customer(id)` | `GET /v1/customers/{id}` |
| `create_customer(data)` | `POST /v1/customers` (idempotente) |
| `update_customer(id, data)` | `PUT /v1/customers/{id}` |
| `deactivate_customer(id)` | `DELETE /v1/customers/{id}` |
| `validate_nif(nif, legal_name)` | `POST /v1/nif/validate` |
| `list_invoices(**params)` | `GET /v1/invoices` |
| `get_invoice(id)` | `GET /v1/invoices/{id}` |
| `create_invoice(data)` | `POST /v1/invoices` (idempotente) |
| `update_invoice(id, data)` | `PUT /v1/invoices/{id}` |
| `delete_invoice(id)` | `DELETE /v1/invoices/{id}` |
| `issue_invoice(id, wait_for_pdf)` | `POST /v1/invoices/{id}/issue` |
| `get_invoice_pdf_url(id)` | `GET /v1/invoices/{id}/pdf` |
| `preview_invoice_pdf(id)` | `GET /v1/invoices/{id}/pdf/preview` (bytes) |
| `send_invoice_email(id, data)` | `POST /v1/invoices/{id}/send` |
| `mark_invoice_paid(id, ...)` | `POST /v1/invoices/{id}/mark-paid` |
| `export_invoices_excel(data)` | `POST /v1/invoices/export/excel` (bytes) |

---

### 4.7 `client/exceptions.py` — Errores tipados

**Para que sirve:** Define una jerarquia de excepciones que permite a las capas superiores reaccionar diferente segun el tipo de error.

```
BeelApiError (base)
├── BeelBadRequestError        (400)
├── BeelUnauthorizedError      (401)
├── BeelForbiddenError         (403)
├── BeelNotFoundError          (404)
├── BeelConflictError          (409)
├── BeelValidationError        (422)
├── BeelRateLimitError         (429)
├── BeelServerError            (5xx)
└── BeelTransportError         (errores de red)
```

Cada excepcion lleva: `status_code`, `code`, `message`, `details`, `request_id` y `retryable`.

---

### 4.8 `client/idempotency.py` — Claves de idempotencia

**Para que sirve:** Genera UUIDs unicos para cada operacion POST. El `beel_client.py` reutiliza la misma clave durante todos los reintentos de un mismo request, garantizando que si un retry llega a BeeL despues de que el primero ya creo el recurso, BeeL devuelve el mismo resultado sin duplicar.

---

### 4.9 Servicios (`services/`)

Los servicios encapsulan la logica de negocio. Cada servicio recibe el `BeelClient` en su constructor y expone metodos de alto nivel.

#### `customer_service.py`
- `search(...)` — Busca clientes por texto libre, NIF, email o nombre fiscal
- `create(data)` — Crea un cliente validando con el schema Pydantic
- `update(id, data)` — Actualiza campos parciales de un cliente
- `find_or_update(...)` — **La logica mas compleja:** busca un cliente por NIF/email/nombre, y si encuentra exactamente uno, opcionalmente lo actualiza. Si no encuentra, devuelve `not_found`. Si encuentra multiples, devuelve `ambiguous`. Esto es lo que usa la tool `upsert_customer`.

#### `nif_service.py`
- `validate(nif, legal_name)` — Llama al endpoint de validacion de NIF de BeeL, que consulta contra AEAT (la agencia tributaria espanola)

#### `invoice_service.py`
- `create_draft(data)` — Crea factura forzando `issue_directly=False` y `send_automatically=False`
- `update_draft(id, data)` — Primero consulta el estado actual, valida con la state machine que esta en DRAFT, y luego actualiza
- `issue(id, wait_for_pdf)` — Consulta estado, valida que es DRAFT, y emite
- `get(id)` — Obtiene factura completa
- `list_invoices(**params)` — Lista facturas con filtros
- `ensure_action_allowed(id, action)` — Consulta + validacion de estado (usado por otras tools)
- `mark_paid(id, ...)` — Valida estado SENT y marca como pagada

#### `pdf_service.py`
- `get_download_url(id)` — URL temporal de descarga del PDF definitivo
- `preview_draft(id)` — Bytes del PDF de previsualizacion (solo borradores)

#### `delivery_service.py`
- `send_email(id, ...)` — Envia factura por email con opciones de destinatarios, CC, asunto, mensaje, idioma y adjunto PDF

#### `verifactu_service.py`
- `get_status(id)` — Extrae datos de VeriFactu de la factura: estado de envio, numero de registro, errores, QR

#### `export_service.py`
- `export_excel(...)` — Exporta facturas a Excel, filtrando por IDs, estado, tipo, fechas o cliente. Formato SUMMARY o ITEMS.

---

### 4.10 Politicas (`policies/`)

#### `state_machine.py` — Maquina de estados de facturas

**Para que sirve:** Impide que el agente ejecute acciones invalidas segun el estado actual de la factura. Esto es un guardrail critico porque emitir una factura tiene efectos fiscales irreversibles.

**Transiciones permitidas:**

| Accion | Estados validos |
|--------|-----------------|
| `update_invoice_draft` | DRAFT |
| `preview_invoice_pdf` | DRAFT |
| `issue_invoice` | DRAFT |
| `send_invoice_email` | ISSUED, SENT, PAID, OVERDUE |
| `mark_invoice_paid` | SENT (conservador) |

Si se intenta una accion desde un estado no permitido, lanza `PolicyViolation` con un mensaje claro.

#### `confirmations.py` — Acciones que requieren confirmacion

**Para que sirve:** Define que acciones son "peligrosas" y requieren que el agente pase `confirm=True` explicitamente. La primera vez que el agente llama a estas tools sin `confirm=True`, recibe un mensaje de advertencia en vez de ejecutar la accion.

**Acciones protegidas:**

| Accion | Razon |
|--------|-------|
| `issue_invoice` | Efectos fiscales irreversibles |
| `send_invoice_email` | Accion operativa real (envia email) |
| `mark_invoice_paid` | Modifica estado contable |
| `export_invoices_excel` | Puede exponer datos fiscales y personales |
| `issue_send_and_track_invoice` | Combina emision + envio en un solo paso |

#### `nif_policy.py` — Politica de validacion de NIF

**Para que sirve:** Evalua el resultado de la validacion de NIF y decide si se puede continuar facturando.

| Estado NIF | Se puede facturar? | Recomendacion |
|------------|-------------------|---------------|
| VALID | Si | Continuar normalmente |
| PENDING | Si (con precaucion) | AEAT no estaba disponible, revalidar luego |
| INVALID | No | Bloquear y corregir NIF |
| Otro/Error | No | Reintentar validacion |

---

### 4.11 Tools (`tools/`) — Lo que ve el agente de IA

Las tools son funciones async que reciben parametros simples (strings, ints, bools, listas, dicts) y devuelven un `dict` estructurado. FastMCP se encarga de serializar a JSON y exponerlas al agente.

Todas las tools siguen el mismo patron:
1. Obtener servicios del lifespan context
2. Si requiere confirmacion, verificar `confirm=True`
3. Validar entrada con Pydantic
4. Llamar al servicio correspondiente
5. Construir respuesta con `success_response()` o `error_response()`
6. Capturar excepciones y devolver error estructurado

#### Tools atomicas (14)

**Clientes (3):**
- `search_customers(query, nif, email, legal_name, page, limit)` — Busca por multiples criterios
- `create_customer(legal_name, street, number, ..., nif, ...)` — Crea con NIF o ID alternativo
- `upsert_customer(search_nif, search_email, search_legal_name, update_data)` — Busca y opcionalmente actualiza; nunca crea

**NIF (1):**
- `validate_nif(nif, legal_name)` — Valida contra AEAT y aplica politica

**Facturas (3):**
- `create_invoice_draft(lines, customer_id|recipient, ...)` — Crea borrador con `customer_id` existente o `recipient` ad-hoc
- `update_invoice_draft(invoice_id, ...)` — Actualiza borrador (solo estado DRAFT)
- `issue_invoice(invoice_id, confirm, wait_for_pdf)` — Emite factura (requiere confirmacion, solo DRAFT)

**PDF (2):**
- `preview_invoice_pdf(invoice_id)` — Genera preview PDF de borrador
- `get_invoice_pdf_download(invoice_id)` — URL temporal de descarga del PDF definitivo

**Envio (1):**
- `send_invoice_email(invoice_id, confirm, recipients, cc, subject, ...)` — Envia por email (requiere confirmacion)

**Pago (1):**
- `mark_invoice_paid(invoice_id, confirm, payment_date, payment_method, ...)` — Marca como pagada (requiere confirmacion, solo SENT)

**Estado (2):**
- `get_invoice_status(invoice_id)` — Detalle completo de la factura con VeriFactu
- `get_verifactu_status(invoice_id)` — Solo el estado VeriFactu (ACCEPTED/REJECTED/PENDING)

**Exportacion (1):**
- `export_invoices_excel(invoice_ids|filtros, format_type, confirm)` — Exporta a Excel (requiere confirmacion)

#### Tools compuestas / workflows (3)

- `ensure_customer_ready_for_invoicing(nif|email|legal_name, validate_nif_flag)` — Busca cliente + valida NIF. Devuelve `customer_ready`, `customer_blocked_by_nif`, `customer_not_found` o `customer_ambiguous`.

- `issue_send_and_track_invoice(invoice_id, confirm, send_email, wait_for_pdf)` — Emite + envia por email + devuelve estado VeriFactu, todo en una llamada. Si falla a mitad, reporta que pasos se completaron.

- `follow_up_unpaid_invoices(status, date_from, date_to, limit)` — Genera informe de facturas vencidas con total pendiente en EUR.

---

### 4.12 Formato de respuesta estandar

Todas las tools devuelven un dict con esta estructura:

```json
{
  "success": true,
  "action_taken": "invoice_issued",
  "human_summary": "Factura emitida. Numero: F-2026-001. Estado: ISSUED.",
  "resource_ids": {
    "invoice_id": "inv_abc123"
  },
  "data": { ... },
  "error": null,
  "next_recommended_actions": ["get_invoice_pdf_download", "send_invoice_email"]
}
```

- `success` — si la operacion fue exitosa
- `action_taken` — identificador semantico de lo que paso
- `human_summary` — texto legible que el agente puede mostrar al usuario
- `resource_ids` — IDs de recursos afectados
- `data` — datos completos de la respuesta
- `next_recommended_actions` — sugerencias al agente de que tool llamar despues

---

## 5. Tests

### `tests/conftest.py`
Fixture compartido que crea un `Settings` con valores de test (API key falsa, timeouts cortos, 1 solo retry).

### `tests/test_client.py`
Verifica que cuando `create_invoice` falla con 500 y luego tiene exito, la `Idempotency-Key` es la misma en ambos intentos. Usa `httpx.MockTransport` para simular la API.

### `tests/test_customer_service.py`
3 tests con un `DummyClient` que simula respuestas de la API:
- `find_or_update` devuelve `not_found` si no hay coincidencias
- `find_or_update` devuelve `ambiguous` si hay multiples coincidencias
- `find_or_update` actualiza cuando hay exactamente una coincidencia

### `tests/test_policies.py`
3 tests:
- NIF con estado PENDING permite continuar
- `issue_invoice` desde estado SENT lanza `PolicyViolation`
- `mark_invoice_paid` desde estado ISSUED lanza `PolicyViolation`

---

## 6. Flujo de vida del servidor

```
1. El cliente MCP (Claude Desktop, etc.) arranca el proceso
2. FastMCP ejecuta el lifespan:
   a. Lee configuracion de .env via get_settings()
   b. Crea BeelClient (cliente HTTP con la API key)
   c. Crea los 7 servicios, todos recibiendo el mismo BeelClient
   d. Pone todo en el diccionario de lifespan_context
3. FastMCP registra las 17 tools
4. El agente de IA hace llamadas a tools via MCP protocol (stdio)
5. Cada tool obtiene sus servicios del lifespan_context
6. Cuando el servidor se cierra, el lifespan cierra el BeelClient
```

---

## 7. Autenticacion

**Metodo actual:** Bearer Token (API Key).

El servidor lee `BEEL_API_KEY` del `.env` y lo envia como header `Authorization: Bearer {key}` en cada request. BeeL diferencia sandbox de produccion por el prefijo de la key:
- `beel_sk_test_*` → sandbox (no genera datos fiscales reales)
- `beel_sk_live_*` → produccion

**OAuth:** Hay documentos de planificacion (`PLAN_CAMBIOS_OAUTH.md`, `GUIA_OAUTH_MCP_BEEL.md`) pero no esta implementado en el codigo.

---

## 8. Diagrama de dependencias entre modulos

```
server.py
├── config.py (get_settings)
├── client/beel_client.py
│   ├── client/exceptions.py
│   ├── client/idempotency.py
│   └── config.py (Settings)
├── services/*
│   └── client/beel_client.py
├── tools/*
│   ├── services/* (via lifespan_context)
│   ├── policies/*
│   ├── schemas.py
│   └── runtime.py
└── runtime.py
    ├── config.py (Settings)
    └── schemas.py (ToolResponse)
```

**Regla fundamental:** Ningun modulo importa `server.py`. Los servicios no importan tools. Las policies no importan servicios. Las dependencias van siempre de arriba hacia abajo.

---

## 9. Endpoints de la API de BeeL utilizados

| Metodo | Endpoint | Usado por |
|--------|----------|-----------|
| GET | `/v1/customers` | search_customers |
| POST | `/v1/customers` | create_customer |
| PUT | `/v1/customers/{id}` | upsert_customer |
| POST | `/v1/nif/validate` | validate_nif |
| GET | `/v1/invoices` | follow_up_unpaid_invoices |
| GET | `/v1/invoices/{id}` | get_invoice_status, validaciones internas |
| POST | `/v1/invoices` | create_invoice_draft |
| PUT | `/v1/invoices/{id}` | update_invoice_draft |
| POST | `/v1/invoices/{id}/issue` | issue_invoice |
| GET | `/v1/invoices/{id}/pdf` | get_invoice_pdf_download |
| GET | `/v1/invoices/{id}/pdf/preview` | preview_invoice_pdf |
| POST | `/v1/invoices/{id}/send` | send_invoice_email |
| POST | `/v1/invoices/{id}/mark-paid` | mark_invoice_paid |
| POST | `/v1/invoices/export/excel` | export_invoices_excel |

---

## 10. Como ejecutar

### Instalar dependencias
```bash
uv sync --extra dev
cp .env.example .env
# Editar .env con tu API key real de BeeL
```

### Ejecutar en desarrollo
```bash
uv run python -m beel_mcp.server
# o
uv run fastmcp run src/beel_mcp/server.py:mcp
```

### Instalar en clientes MCP
```bash
# Claude Desktop
uv run fastmcp install claude-desktop src/beel_mcp/server.py:mcp \
  --server-name "BeeL Facturacion" --env-file .env

# Claude Code
uv run fastmcp install claude-code src/beel_mcp/server.py:mcp \
  --server-name "BeeL Facturacion" --env-file .env

# Cursor
uv run fastmcp install cursor src/beel_mcp/server.py:mcp \
  --server-name "BeeL Facturacion" --env-file .env
```

### Ejecutar tests
```bash
uv run pytest -q
```

---

## 11. Lo que NO esta implementado

- OAuth 2.0 (planificado pero sin codigo)
- Webhooks de BeeL (notificaciones en tiempo real)
- Facturas recurrentes
- Catalogo de productos/servicios
- Gestion de series de facturacion
- Perfiles de empresa via `X-Active-Profile`
- Tools de anulacion o duplicado de facturas
