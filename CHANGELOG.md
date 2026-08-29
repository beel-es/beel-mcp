# Changelog

Las entradas las genera [release-please](https://github.com/googleapis/release-please)
a partir de los Conventional Commits fusionados en `master`.

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
