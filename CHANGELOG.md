# Changelog

Las entradas las genera [release-please](https://github.com/googleapis/release-please)
a partir de los Conventional Commits fusionados en `master`.

## [0.10.0](https://github.com/beel-es/beel-mcp/compare/v0.9.0...v0.10.0) (2026-09-30)


### Novedades

* **cf:** record MCP tool usage in product analytics ([dbd9eec](https://github.com/beel-es/beel-mcp/commit/dbd9eec1e232cbb1784f72464b6e144d4e317a9e))
* **cf:** record MCP tool usage in product analytics ([c98d623](https://github.com/beel-es/beel-mcp/commit/c98d623ee1af833ae532d0c6fd185f7094816af8))

## [0.9.0](https://github.com/beel-es/beel-mcp/compare/v0.8.0...v0.9.0) (2026-09-28)


### Novedades

* fewer calls and smaller results for agents building an integration ([#114](https://github.com/beel-es/beel-mcp/issues/114)) ([e816046](https://github.com/beel-es/beel-mcp/commit/e8160461b895ff5378dc4be99d17f89158d44d54))

## [0.8.0](https://github.com/beel-es/beel-mcp/compare/v0.7.0...v0.8.0) (2026-09-27)


### Novedades

* read docs by section and fiscal rules in batches ([#112](https://github.com/beel-es/beel-mcp/issues/112)) ([c38d46f](https://github.com/beel-es/beel-mcp/commit/c38d46f46ad26425ed924fc66659099bd750c383))

## [0.7.0](https://github.com/beel-es/beel-mcp/compare/v0.6.0...v0.7.0) (2026-09-27)


### ⚠ BREAKING CHANGES

* **docs:** beel_docs_search takes `query` (a string) instead of `terms` (a list), `limit` is capped at 20, and it accepts an optional `area`. beel_docs_get also accepts a result's url or md_url.

### Novedades

* **docs:** search through the docs site's search endpoint, read one page at a time ([9c7f990](https://github.com/beel-es/beel-mcp/commit/9c7f990ca3e61edad824f99dedd76a09593e33bd))
* **guidance:** one place for general guidance, short tool descriptions ([fb55f63](https://github.com/beel-es/beel-mcp/commit/fb55f63bf4114ce6aea51018aee8038b6649fc71))

## [0.6.0](https://github.com/beel-es/beel-mcp/compare/v0.5.0...v0.6.0) (2026-09-27)


### ⚠ BREAKING CHANGES

* payment-connection tools address the connection by connection_id instead of provider, and beel_create_series requires document_type.

### Novedades

* align with the production API contract (payment connections by connection_id, series document type, event resolution) ([#101](https://github.com/beel-es/beel-mcp/issues/101)) ([154f96f](https://github.com/beel-es/beel-mcp/commit/154f96f3526b1d0a54f97ebf7ca875a08a999fe3))
* **rules:** serve the published fiscal rules catalogue as tools and resources ([#103](https://github.com/beel-es/beel-mcp/issues/103)) ([241950e](https://github.com/beel-es/beel-mcp/commit/241950ec1d6073d2a490d526e79c099bffae0261))
* **rules:** tell the agent when to consult the fiscal rules ([#107](https://github.com/beel-es/beel-mcp/issues/107)) ([dad6050](https://github.com/beel-es/beel-mcp/commit/dad6050277cf1558400567526ea4fec9cda5db33))


### Correcciones

* **oauth:** answer every token-less request to /mcp with the challenge ([#99](https://github.com/beel-es/beel-mcp/issues/99)) ([21c5e2c](https://github.com/beel-es/beel-mcp/commit/21c5e2ccffc25f5dc3cc183c399343c304dd3d09))
* **oauth:** report why the token endpoint rejected an exchange ([#102](https://github.com/beel-es/beel-mcp/issues/102)) ([b8d045f](https://github.com/beel-es/beel-mcp/commit/b8d045f9c530ff72c9dfd9d3e15d145033c5c6a0))
* **oauth:** tell a transient upstream failure from a configuration fault ([#104](https://github.com/beel-es/beel-mcp/issues/104)) ([82a463e](https://github.com/beel-es/beel-mcp/commit/82a463e5522382893aaa83ae0449ae17c728861a))


### Documentación

* **agents:** what must not be written in a public PR ([#89](https://github.com/beel-es/beel-mcp/issues/89)) ([b53aa91](https://github.com/beel-es/beel-mcp/commit/b53aa91049a6b2fa09cb22b3bd5ba6141e06fb34))

## [0.5.0](https://github.com/beel-es/beel-mcp/compare/v0.4.2...v0.5.0) (2026-08-29)


### Novedades

* **discovery:** public resources/read and prompts/get, CSP meta in the viewer (#BEE-1443) ([#86](https://github.com/beel-es/beel-mcp/issues/86)) ([6edf8cd](https://github.com/beel-es/beel-mcp/commit/6edf8cd01d2d6de874c69fd6f7e8efef87b73a1a))
* **oauth:** advertise scopes_supported and add opt-in public discovery (#BEE-1443) ([#84](https://github.com/beel-es/beel-mcp/issues/84)) ([3ddaf71](https://github.com/beel-es/beel-mcp/commit/3ddaf7130e225fc7a79d9dd2462f2e6646550a19))
* **oauth:** agent_auth block in the authorization-server metadata (#BEE-1443) ([#88](https://github.com/beel-es/beel-mcp/issues/88)) ([dc72c12](https://github.com/beel-es/beel-mcp/commit/dc72c12344089285198d93aff6aed758a9329b27))


### Documentación

* AGENTS.md for coding agents and an Agent Plugins manifest (#BEE-1443) ([#87](https://github.com/beel-es/beel-mcp/issues/87)) ([2fda2d9](https://github.com/beel-es/beel-mcp/commit/2fda2d99459f5e360ca8dd70f79f29029a0ad811))

## [0.4.2](https://github.com/beel-es/beel-mcp/compare/v0.4.1...v0.4.2) (2026-08-29)


### Correcciones

* **security:** errores de autorización como 4xx, TTL en registros DCR, publish solo desde tag y sync-spec por PR ([#82](https://github.com/beel-es/beel-mcp/issues/82)) ([6353e83](https://github.com/beel-es/beel-mcp/commit/6353e83b76f6bb37f43cab9d0b979b1cb7ba8475))
* **spec:** el contrato sincronizado deja de citar los hosts de almacenamiento en sus ejemplos ([#83](https://github.com/beel-es/beel-mcp/issues/83)) ([195acec](https://github.com/beel-es/beel-mcp/commit/195acecf4a7429a06397cab1536fa36cdfd47ae2))


### Documentación

* **community:** plantillas de PR e issues, código de conducta y guía para contribuir ([#80](https://github.com/beel-es/beel-mcp/issues/80)) ([ff82f9a](https://github.com/beel-es/beel-mcp/commit/ff82f9a60b7433eb565acacb16848e1e674bf175))

## [0.4.1](https://github.com/beel-es/beel-mcp/compare/v0.4.0...v0.4.1) (2026-08-29)


### Documentación

* CHANGELOG versionado y badges de CI y releases en el README ([#76](https://github.com/beel-es/beel-mcp/issues/76)) ([79fcf89](https://github.com/beel-es/beel-mcp/commit/79fcf89e3bf95e3658f3a4b8757e7ed5d5fd59ed))

## 0.4.0 (2026-08-29)

### Novedades

* Validación de argumentos contra el schema de cada herramienta también en el servidor remoto (Cloudflare Workers).
* Nombres de herramienta coherentes con el contrato: `beel_get_company`, `beel_patch_company`, `beel_delete_company`, `beel_activate_company`, `beel_deactivate_company`, `beel_delete_company_logo` (antes `beel_*_by_id`).
* `destructiveHint`/`idempotentHint` derivados del contrato (`x-irreversible`, verbo HTTP, cabecera `Idempotency-Key`).
* Schemas más compactos y estrictos: sin `example` ni propiedades `readOnly`, `additionalProperties: false`.

### Correcciones

* El puente OAuth no reutiliza un estado de autorización; un fallo de refresco obliga a reconsentir; el entorno se lee del token emitido.
* `beel_get_setup_status` ya no informa "listo para emitir" cuando una comprobación falló; cada sección expone su error.
* `Idempotency-Key` solo en las operaciones que la declaran; los reintentos de mutaciones sin clave se limitan a 429/503.
* Se retira `beel_put_owner`: solo está disponible con sesión del dashboard, nunca con credencial de API.
