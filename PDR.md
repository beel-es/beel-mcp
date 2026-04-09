Sí. Y de hecho tiene bastante sentido.

Por lo que veo en la documentación de BeeL, la API ya cubre casi todas las piezas necesarias del flujo que quieres exponer por lenguaje natural: búsqueda y creación de clientes, validación de NIF contra AEAT, creación y actualización de facturas, emisión desde borrador, previsualización PDF, descarga PDF, envío por email, marcado como pagada, exportación a Excel y notificaciones/webhooks para cambios de estado de VeriFactu. Además, BeeL exige `Authorization: Bearer`, usa la misma base URL para sandbox y producción, y recomienda `Idempotency-Key` en endpoints de creación para evitar duplicados. ([docs.beel.es][1])

Te propongo este **PDR** ya aterrizado:

---

# PDR — MCP de BeeL para facturación ejecutable por lenguaje natural

## 1. Resumen

Construir un **MCP server para BeeL** que permita a un agente ejecutar de extremo a extremo el ciclo operativo de facturación en España mediante lenguaje natural.

El MCP convertirá BeeL de “API de facturación” a **capa transaccional ejecutable por agentes**, permitiendo instrucciones como:

* “Busca a este cliente por NIF y, si no existe, créalo”
* “Valida el NIF antes de emitir”
* “Crea la factura en borrador y enséñame el PDF”
* “Emítela y envíala por email”
* “Márcala como pagada hoy por transferencia”
* “Dime si VeriFactu la aceptó”
* “Exporta las facturas pendientes de marzo”
* “Saca seguimiento de impagadas y prepara recordatorio”

Esto encaja bien con BeeL porque la API ya soporta el ciclo completo de factura y además expone estado de VeriFactu, envío por email y exportación. ([docs.beel.es][1])

---

## 2. Problema

Hoy BeeL es muy potente como API, pero para usarla hay que:

1. conocer endpoints,
2. montar validaciones,
3. controlar estados,
4. encadenar varias llamadas correctamente,
5. gestionar errores e idempotencia.

Eso frena su uso desde agentes. Un agente no debería “conocer REST”; debería poder razonar sobre intenciones de negocio como **crear factura**, **enviarla**, **cobrarla** o **revisar VeriFactu**. BeeL ya ofrece esos primitives, pero no como interfaz conversacional ejecutable. ([docs.beel.es][1])

---

## 3. Objetivo del producto

Crear un MCP que permita a cualquier cliente compatible:

* operar BeeL con lenguaje natural,
* ejecutar flujos multi-step de forma segura,
* minimizar errores fiscales y duplicados,
* exponer resultados claros al agente y al usuario final,
* soportar tanto acciones atómicas como workflows completos.

---

## 4. Resultado esperado

Un agente conectado al MCP debe poder completar este flujo:

1. **buscar o crear cliente**
2. **validar NIF**
3. **crear factura en borrador o emitirla directamente**
4. **descargar o previsualizar PDF**
5. **enviarla por email**
6. **marcarla como pagada**
7. **consultar estado VeriFactu**
8. **exportar facturas o lanzar seguimiento**

La documentación confirma piezas concretas para ese flujo: `GET /v1/customers`, `POST /v1/customers`, `POST /v1/nif/validate`, `POST /v1/invoices`, `PUT /v1/invoices/{invoice_id}`, `POST /v1/invoices/{invoice_id}/issue`, `GET /v1/invoices/{invoice_id}/pdf/preview`, PDF descargable asociado a la factura, `POST /v1/invoices/{invoice_id}/send`, `POST /v1/invoices/{invoice_id}/mark-paid`, `GET /v1/invoices/{invoice_id}` con bloque `verifactu`, webhooks `verifactu.status.updated` y `POST /v1/invoices/export/excel`. ([docs.beel.es][1])

---

## 5. Usuarios objetivo

### Usuario primario

Autónomos, despachos, SaaS verticales y plataformas que quieran delegar facturación a un agente.

### Usuario secundario

Desarrolladores que integran BeeL en productos con asistentes IA.

### Usuario terciario

Equipos de operaciones o administración que quieren usar BeeL desde chat interno.

---

## 6. Casos de uso principales

### Caso 1 — Alta rápida de cliente y factura

“Crea una factura para Talleres Rivera por 350 € + IVA. Si el cliente no existe, créalo.”

### Caso 2 — Flujo con control humano

“Prepara la factura en borrador, enséñame el PDF y no la emitas hasta que te diga.”

### Caso 3 — Flujo totalmente automático

“Valida el NIF, emite la factura y envíala al email de facturación.”

### Caso 4 — Cobro

“Marca como pagada la factura 2026-014 por transferencia con fecha 5 de abril.”

### Caso 5 — Compliance

“Comprueba si la AEAT aceptó la última factura emitida.”

### Caso 6 — Seguimiento

“Exporta todas las facturas vencidas y genera un seguimiento para reclamar cobro.”

Aquí hay un matiz importante: **la exportación está claramente soportada por la API**, pero **“lanzar seguimiento” no aparece como endpoint específico en la documentación pública revisada**. Esa parte conviene modelarla como workflow del agente usando listado/filtrado/exportación, lectura de `due_date` y `status`, y eventualmente acciones como email externo o cambio de estado manual, más que como una capacidad nativa de BeeL ya cerrada. ([docs.beel.es][1])

---

## 7. Alcance funcional del MCP

## 7.1 Herramientas MCP mínimas

### 1. `search_customers`

Busca clientes por nombre, NIF, email o texto libre.

**Mapeo BeeL:** `GET /v1/customers` con filtros como `search`, `legal_name`, `nif`, `email`, `phone`, `city`, `province`. ([docs.beel.es][1])

### 2. `create_customer`

Crea un cliente nuevo.

**Mapeo BeeL:** `POST /v1/customers`. El cuerpo acepta `legal_name`, `trade_name`, `nif` o identificador alternativo, dirección, teléfono y email. ([docs.beel.es][1])

### 3. `validate_nif`

Valida NIF/CIF contra AEAT antes de registrar o facturar.

**Mapeo BeeL:** `POST /v1/nif/validate`. Devuelve estados como `VALID`, `INVALID`, `PENDING` y `ERROR`. ([docs.beel.es][1])

### 4. `upsert_customer`

Busca un cliente existente por NIF, nombre o email y, si lo encuentra, actualiza sus datos con los campos proporcionados.

* Si existe, actualiza los campos indicados y devuelve el `customer_id` con los datos actualizados.
* Si no existe, devuelve `customer_not_found` con los datos de búsqueda utilizados, para que el agente decida si invocar `create_customer`.

No crea clientes; esa responsabilidad recae en `create_customer`.

**Mapeo BeeL:** `GET /v1/customers` para búsqueda + `PUT /v1/customers/{customer_id}` para actualización. ([docs.beel.es][1])

### 5. `create_invoice_draft`

Crea una factura en estado borrador.

**Mapeo BeeL:** `POST /v1/invoices`. La documentación indica ciclo completo de creación y posterior emisión; además solo las facturas en `DRAFT` son modificables y luego pueden emitirse. ([docs.beel.es][1])

### 6. `update_invoice_draft`

Actualiza una factura borrador.

**Mapeo BeeL:** `PUT /v1/invoices/{invoice_id}`. Solo admite facturas en `DRAFT`. ([docs.beel.es][1])

### 7. `issue_invoice`

Emite una factura borrador.

**Mapeo BeeL:** `POST /v1/invoices/{invoice_id}/issue`. Cambia `DRAFT → ISSUED`. ([docs.beel.es][1])

### 8. `preview_invoice_pdf`

Previsualiza PDF de borrador.

**Mapeo BeeL:** `GET /v1/invoices/{invoice_id}/pdf/preview`. Solo para borradores; devuelve `application/pdf`. ([docs.beel.es][1])

### 9. `get_invoice_pdf_download`

Obtiene URL temporal de descarga del PDF emitido.

**Mapeo BeeL:** la factura expone `pdf_download_url` y hay respuesta con `download_url` prefirmada válida 5 minutos. ([docs.beel.es][1])

### 10. `send_invoice_email`

Envía la factura por email al cliente.

**Mapeo BeeL:** `POST /v1/invoices/{invoice_id}/send`. Envía al email de facturación del cliente e incluye el PDF. ([docs.beel.es][1])

### 11. `mark_invoice_paid`

Marca la factura como pagada.

**Mapeo BeeL:** `POST /v1/invoices/{invoice_id}/mark-paid`. Soporta `payment_date` y detalles de método de pago. ([docs.beel.es][1])

### 12. `get_invoice_status`

Recupera detalles completos de una factura, incluido estado y bloque VeriFactu.

**Mapeo BeeL:** `GET /v1/invoices/{invoice_id}`. La respuesta incluye estado, fechas, PDF y datos VeriFactu cuando existan. ([docs.beel.es][1])

### 13. `get_verifactu_status`

Devuelve un resumen normalizado del estado de registro en AEAT.

**Mapeo BeeL:** derivado de `GET /v1/invoices/{invoice_id}` y de eventos `verifactu.status.updated`, cuyos estados incluyen `PENDING`, `ACCEPTED` y `REJECTED`. ([docs.beel.es][1])

### 14. `export_invoices_excel`

Exporta facturas a Excel por IDs o filtros.

**Mapeo BeeL:** `POST /v1/invoices/export/excel`. Soporta formatos `SUMMARY` e `ITEMS`. ([docs.beel.es][1])

### 15. `follow_up_unpaid_invoices`

Tool de alto nivel para seguimiento de cobro.

**Mapeo BeeL realista:** no parece existir un endpoint público específico de “seguimiento”. Debe construirse como orquestación con:

* listado/filtrado de facturas,
* inspección de `status`, `due_date`, `sending_history`,
* exportación a Excel,
* y opcionalmente integración adicional para mandar recordatorios fuera de BeeL. ([docs.beel.es][1])

---

## 8. Herramientas compuestas clave

Estas son las que de verdad convierten BeeL en “ejecutable por lenguaje natural”.

### A. `ensure_customer_ready_for_invoicing`

Hace:

1. buscar cliente con `upsert_customer`,
2. si no existe, devolver `customer_not_found` con sugerencia de validar NIF y crear cliente,
3. si existe, validar NIF opcionalmente,
4. devolver `customer_id` y estado de validación, o bien `customer_not_found` para que el agente solicite confirmación antes de crear.

### B. `draft_or_issue_invoice_workflow`

Entrada:

* datos del cliente,
* líneas,
* impuestos,
* modo = `draft` o `issue_now`.

Comportamiento:

* busca cliente con `upsert_customer`,
* si no existe, aborta y devuelve `customer_not_found` (el agente debe crear el cliente primero con `create_customer`),
* si existe, crea factura,
* si `draft`, devuelve preview PDF,
* si `issue_now`, la emite y devuelve estado + opción de envío.

### C. `issue_send_and_track_invoice`

Hace:

1. busca cliente con `upsert_customer`,
2. si no existe, aborta con `customer_not_found`,
3. valida NIF,
4. crea factura,
5. emite,
6. envía por email,
7. consulta estado final,
8. devuelve resumen compacto con invoice number, PDF y estado VeriFactu inicial.

### D. `close_invoice_collection_loop`

Hace:

1. obtiene factura,
2. verifica que su estado permita el cambio,
3. marca como pagada,
4. devuelve estado actualizado y fecha de cobro.

---

## 9. Reglas de negocio del MCP

### 9.1 Confirmaciones obligatorias

El MCP debería exigir confirmación explícita antes de:

* emitir una factura,
* enviar una factura por email,
* marcar una factura como pagada,
* exportar grandes volúmenes si hay riesgo de error operativo.

La razón es que estas acciones tienen consecuencias fiscales u operativas reales.

### 9.2 Política de NIF

* Si `validate_nif` devuelve `VALID`, continuar.
* Si devuelve `INVALID`, bloquear por defecto.
* Si devuelve `PENDING`, permitir continuar con aviso, porque BeeL documenta que ese estado puede significar formato válido pero verificación AEAT temporalmente no disponible. ([docs.beel.es][1])

### 9.3 Idempotencia

Todas las tools que disparen `POST` de creación o acciones no triviales deben generar `Idempotency-Key` automáticamente. BeeL remarca esa necesidad en la documentación y en su skill para Claude Code. ([docs.beel.es][2])

### 9.4 Estados de factura

El MCP no debe dejar al agente improvisar transiciones inválidas. BeeL documenta transiciones concretas como `DRAFT → ISSUED`, `ISSUED → SENT`, `SENT → PAID`, y cambios masivos a `PAID` también desde `ISSUED`, `SENT` u `OVERDUE`. ([docs.beel.es][1])

---

## 10. UX esperada para el agente

El MCP no debería obligar al agente a construir payloads fiscales completos desde cero en cada turno. Debe aceptar una entrada más semántica, por ejemplo:

> “Factura a Nombre X, NIF Y, 2 horas de consultoría a 80 €, IVA 21 %, vencimiento a 30 días, crea borrador.”

Y devolver algo como:

* cliente encontrado/creado,
* NIF validado: `VALID`,
* factura creada en `DRAFT`,
* preview PDF disponible,
* siguiente acción recomendada: emitir o editar.

O bien:

> “Emítela y envíala.”

Respuesta:

* factura emitida,
* número definitivo asignado,
* email enviado,
* estado actual,
* estado VeriFactu inicial.

---

## 11. Arquitectura propuesta

## 11.1 Stack

En Python yo lo haría con **FastMCP** o con el SDK oficial `mcp`, y un cliente HTTP propio para BeeL. A nivel de diseño, el valor no está en “exponer endpoints 1:1”, sino en una capa intermedia de orquestación y validación.

## 11.2 Capas

### Capa 1 — BeeL client

Wrapper HTTP tipado:

* auth,
* idempotency,
* retries,
* normalización de errores.

### Capa 2 — Servicios de dominio

* customer_service
* nif_service
* invoice_service
* verifactu_service
* export_service
* followup_service

### Capa 3 — Tools MCP

Tools pequeñas y compuestas.

### Capa 4 — Policies

* confirmaciones
* validaciones
* guardrails fiscales
* reglas por entorno sandbox/live

---

## 12. Diseño de respuestas de las tools

Cada tool debería devolver siempre:

* `success`
* `action_taken`
* `resource_ids`
* `human_summary`
* `next_recommended_actions`
* `raw_beel_response` opcional

Ejemplo:

```json
{
  "success": true,
  "action_taken": "invoice_created_in_draft",
  "resource_ids": {
    "customer_id": "…",
    "invoice_id": "…"
  },
  "human_summary": "Se encontró el cliente, el NIF es válido y la factura quedó creada en borrador.",
  "next_recommended_actions": [
    "preview_pdf",
    "issue_invoice"
  ]
}
```

Así el agente puede razonar mucho mejor que si solo recibe JSON crudo.

---

## 13. Errores que el MCP debe abstraer

### Error 1 — cliente duplicado

Resolver vía búsqueda previa por NIF/email/nombre antes de crear. BeeL ya ofrece búsqueda paginada y estados de validación de clientes en importaciones, incluyendo duplicados y NIF inválido. ([docs.beel.es][1])

### Error 2 — NIF inválido

Bloquear emisión y ofrecer:

* corregir NIF,
* crear cliente sin emitir,
* continuar solo con override explícito si el negocio lo permite.

### Error 3 — emisión fallida por datos incompletos

Si `issue` falla, devolver un resumen accionable:

* campo faltante,
* impuesto inconsistente,
* cliente incompleto.

### Error 4 — PDF no disponible

BeeL documenta casos donde el PDF puede no estar generado aún para descarga. El MCP debe caer a `preview` si sigue en borrador o reintentar consulta si acaba de emitirse. ([docs.beel.es][1])

### Error 5 — VeriFactu pendiente o rechazado

El MCP debe separar claramente:

* factura emitida en BeeL,
* factura aceptada por AEAT.

BeeL documenta estados como `PENDING`, `ACCEPTED` y `REJECTED`, tanto en la respuesta de factura como en webhook. ([docs.beel.es][1])

---

## 14. No funcionales

### Seguridad

* API key en variable de entorno.
* Nunca exponer la key al modelo.
* Logs redactados.
* Confirmaciones antes de acciones irreversibles.

### Robustez

* Retries con backoff.
* Idempotency-Key automática.
* Timeouts claros.
* Trazabilidad con `request_id` cuando BeeL lo devuelva. ([docs.beel.es][1])

### Rendimiento

BeeL publica límites estándar de 100 req/min en CRUD y 1000 req/min global fallback, así que el MCP debe agrupar llamadas cuando pueda y evitar polling excesivo. ([docs.beel.es][1])

---

## 15. MVP recomendado

Yo haría un **MVP en dos fases**.

### Fase 1 — núcleo operativo

* `search_customers`
* `create_customer`
* `validate_nif`
* `create_invoice_draft`
* `issue_invoice`
* `preview_invoice_pdf`
* `get_invoice_pdf_download`
* `send_invoice_email`
* `mark_invoice_paid`
* `get_invoice_status`

### Fase 2 — capa realmente agentic

* `upsert_customer` (ya incluida en Fase 1 como tool atómica)
* `draft_or_issue_invoice_workflow`
* `issue_send_and_track_invoice`
* `export_invoices_excel`
* `follow_up_unpaid_invoices`
* soporte webhook `verifactu.status.updated`

---

## 16. Qué vendería BeeL con esto

La propuesta de valor no sería “tenemos API”, sino:

**“BeeL se convierte en infraestructura de facturación operable por agentes.”**

Mensajes potentes:

* “Convierte facturación en acciones por lenguaje natural”
* “No solo integras BeeL; dejas que tus agentes la operen”
* “BeeL pasa de API REST a sistema transaccional ejecutable”
* “Tus usuarios pueden facturar, enviar, cobrar y verificar AEAT desde chat”

Eso está alineado con lo que realmente ofrece la API hoy: ciclo completo de factura, PDF, email, exportes y VeriFactu. ([docs.beel.es][1])

---

## 17. Mi recomendación concreta

Sí lo construiría, pero **no como un espejo 1:1 de endpoints**.

Lo haría como un MCP con dos niveles:

* **tools atómicas**: para máxima precisión y control,
* **tools compuestas**: para que un agente pueda completar el flujo empresarial real sin tener que “saber de facturación”.

La idea más fuerte aquí es esta:

**el verdadero producto no es “MCP para BeeL”, sino “BeeL como runtime fiscal ejecutable por lenguaje natural”.**

Y eso, bien empaquetado, es muy potente.

Si quieres, en el siguiente mensaje te lo convierto en una versión más ejecutiva y lista para compartir con tu equipo, o directamente en una **spec técnica del MCP en Python con nombre de tools, inputs y outputs exactos**.

[1]: https://docs.beel.es/llms-full.txt "docs.beel.es"
[2]: https://docs.beel.es/invoices/createInvoice?utm_source=chatgpt.com "Create invoice - BeeL. API"
