# Changelog

Las entradas las genera [release-please](https://github.com/googleapis/release-please)
a partir de los Conventional Commits fusionados en `master`.

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
