# Aprendizajes construyendo el MCP de BeeL con Claude Code

Registro estilo RL: cada tropiezo real y su corrección, para destilar después una
skill "cómo construir un MCP con Claude Code".

## Spec-driven / OpenAPI

1. **La spec embebida caduca en silencio.** Dos meses sin sync = 96 archivos de drift.
   Re-bundlear siempre desde `origin/develop` (worktree efímero), nunca desde la rama
   local del backend, que puede ser cualquier cosa.
2. **Una migración de API duplica la superficie de tools.** Al añadir la capa
   `/companies/{id}/...` la spec pasó a 216 operaciones y el server exponía legacy +
   nuevo (192 tools). Regla de policy data-driven: excluir `deprecated: true` del
   contrato (98 ops fuera de golpe). Anthropic: pocas tools de alto impacto; más tools
   = más tokens y más confusión del agente.
3. **Los operationIds legados se fijan en todas partes.** Guardrails (`BY_OPERATION_ID`),
   annotations (`DESTRUCTIVE_OPERATION_IDS`), prompts de workflow, registry de MCP Apps
   y tests referencian ids que la migración deja obsoletos. Al excluir deprecated se
   rompen en cadena: grep por los ids viejos ANTES de correr los tests, y mapear
   tag-fallbacks también (los tags nuevos cambian: `Invoices` → `CompanyInvoices`).
4. **Los paths de la spec usan snake_case** (`{company_id}`), no camelCase. Los asserts
   de tests que citan endpoints literales fallan por eso, no por lógica.

## OAuth remoto (la fuente nº1 de fallos históricos)

5. **No artesanar el Authorization Server.** El historial del repo (BEE-237) son 8
   commits seguidos parcheando OAuth a mano: proxy /authorize+/token, shim DCR, JWT
   propio + JWKS, trust proxy… Cloudflare `workers-oauth-provider` da DCR + endpoints +
   tokens en KV mantenidos por ellos; nuestro código queda en 2 rutas Hono
   (/authorize redirect upstream, /callback → completeAuthorization con el token BeeL
   cifrado en props).
6. **`tokenExchangeCallback` no recibe `env`**: capturarlo en el `fetch` del Worker
   (wrapper) si el refresh upstream necesita config.
7. **El redirect_uri upstream cambia de arquitectura.** Con el proxy antiguo, BeeL
   registraba el callback de claude.ai; con el Worker-AS, hay que registrar
   `https://<worker>/callback` en `OAUTH2_REDIRECT_URIS` del backend. Si no, el paso
   2→3 del flujo muere y parece "fallo del MCP".

## Port a Cloudflare Workers

8. **Inventariar los touchpoints de Node ANTES de portar**: `grep "node:"` sobre el
   árbol. Aquí eran 4: spec desde disco, HTML del MCP App desde disco, caché de docs
   en tmpdir, `randomUUID`. Solución: inyección (`setSpecSource`, `setPdfAppHtml`),
   caché en memoria, `crypto.randomUUID()` global. El resto del núcleo era portable
   tal cual porque ya estaba separado del transporte.
9. **Text modules en vez de fs**: `rules: [{type:"Text", globs:["**/*.yaml","**/*.html"]}]`
   en wrangler.jsonc + `declare module '*.yaml'`.
10. **Dos tsconfig**: el de Node (excluye `src/cf`) y `tsconfig.cf.json` con
    `types: ["@cloudflare/workers-types","node"]` (excluye la capa Express legada).
    Sin esto, los globals de Workers y Node se pisan.
11. **`agents` peerOptional de vite choca con vitest 2** → `--legacy-peer-deps` es
    seguro (el peer es para su dev-server, no runtime).
12. **`wrangler deploy --dry-run --outdir`** caza errores de bundling (imports de texto,
    builtins) sin tocar producción. KV: `wrangler kv namespace create` no edita tu
    config en modo no interactivo — copiar el id a mano.

## Proceso / harness

13. **`tsx -e` con imports relativos no resuelve** — escribir siempre un script .mts en
    disco. Y scripts temporales al scratchpad de la sesión, no a `/tmp`.
14. **`echo ===` revienta en zsh** (expansión `=cmd`). Usar `echo ---`.
15. **Smoke-test stdio**: al parsear stdout línea a línea, vaciar el buffer
    (`lines.pop()`) o se reprocesan mensajes. Y el server escribe logs por stderr —
    no mezclarlos con el canal JSON-RPC.
16. **Las credenciales guardadas caducan**: la key de `~/.config/beel/config.json`
    daba 401. Verificar la credencial con un curl de status ANTES de culpar al server.

## Despliegue / DNS / e2e

18. **`custom_domain: true` en wrangler crea DNS + cert solos** — no crear el registro a
    mano. Pero si consultaste el host ANTES de existir, macOS cachea el NXDOMAIN un buen
    rato: `dig` (va directo al resolver) dice OK mientras curl/node fallan con ENOTFOUND.
    Sin sudo para flush, `curl --resolve host:443:IP` desbloquea el trabajo.
19. **El redirect_uri upstream vive en la config del backend, no del MCP.** Buscar dónde
    corre de verdad el backend (aquí Railway `pacific-vitality`, no Dokploy como decía el
    DEPLOY.md antiguo) y añadir el callback como env var (`OAUTH2_REDIRECT_URIS`)
    preservando los valores default del yml — la var REEMPLAZA el default entero.
20. **Probar el flujo OAuth sin cliente MCP real**: DCR por curl → PKCE a mano → listener
    local en el redirect_uri → navegador (sesión real del usuario) para el login → canje
    del code por curl → llamada MCP con el bearer. Cada eslabón aislable = errores
    diagnosticables.

21. **El issuer OAuth del backend no es el dominio pelado**: Spring authserver vivía en
    `https://app.beel.es/api` (el SPA se come `/oauth2/*` en la raíz y da 404). Probar el
    endpoint con curl (`302 → /login` = bueno) antes de mandar al navegador.
22. **El body de las tools va anidado** (`arguments.body.{...}`): un 415 "content type
    unknown" tras el OAuth no era bug del server sino llamada mal formada (args en la
    raíz). Los agentes cometerán el mismo error → candidato a aplanar el inputSchema.

23. **Los clientes MCP no piden scopes**: Claude manda el authorize sin parámetro
    `scope` → si lo pasas tal cual upstream, el token sale vacío y todo da 403. El
    servidor debe tener un DEFAULT_SCOPES sensato (sin `sandbox`: conectar = datos
    reales) y pedirlo cuando el cliente no pide nada.
24. **El registro de scopes del cliente OAuth deriva**: la API ganó `companies:list`
    en la migración multinif pero el cliente `beel-mcp` del backend seguía con el
    catálogo viejo → callejón sin salida estructural (todas las rutas son
    company-scoped y descubrir el company_id exige justo el scope ausente). Al evolucionar
    la API, auditar TAMBIÉN el registro de clientes OAuth, no solo la spec. (PR #2919)
25. **Probar con el cliente real, no solo con curl**: el flujo a mano (curl+PKCE) pasó
    porque yo sí pedía scopes; el conector de Claude falló porque no los pide. Cada
    cliente ejercita el contrato de forma distinta.

## E2E local destapa lo que los tests unitarios y el mock no

26. **MapStruct con `source` escalar `String` mapea TODOS los targets a la misma
    expresión**: `@Mapping(target="scope", source="scopeValue")` +
    `@Mapping(target="descriptionKey", expression=...)` generó `setScope(descriptionKey(...))`
    → el scope salía con el prefijo i18n `oauth2.scope.`. Con un solo parámetro String,
    escribir el mapper a mano (o `@Named`) evita la ambigüedad. Un test que assertara
    los dos campos por separado lo habría cazado — el del agente solo miraba uno.
27. **El mock miente por construcción**: mi mock devolvía `client_name:"Claude"` y scopes
    limpios; el backend real devuelve el clientName del registro ("BeeL MCP") y, sin
    resolver la aserción, `verified:false`. Los contratos entre dos agentes que trabajan
    en paralelo solo se validan de verdad con ambos lados vivos.
28. **El dato para verificar identidad no llega al endpoint que lo necesita**: el
    consent-context se llama con `client_id`+`scope` pero la aserción firmada vive en el
    authorization-request de Spring, localizable solo por `state` — que el frontend no
    reenviaba. Diseñar el contrato mirando de dónde sale cada dato, no solo qué muestra.
29. **Arranque local del backend, orden de secretos que hacen fail-fast** (cada uno aborta
    el boot con mensaje claro, hay que ir añadiéndolos): `ENCRYPTION_SECRET_KEY` debe
    decodificar a EXACTAMENTE 32 bytes base64 (AES-256) — `openssl rand -base64 32`, no un
    literal a ojo; `EMAIL_PROVIDER` debe ser `smtp`/`resend` (no `noop`, no existe el bean);
    todos los `STRIPE_*` obligatorios aunque sean dummy; declarar el bean
    `OAuth2AuthorizationService` explícito al retirar la auto-config del authserver.
    Signup exige `accept_terms:true`; verificar email por SQL (`UPDATE person SET
    email_verified=true`) o cargar `db/seed.sql` (usuarios con datos, password `password123`).

## Diseño de tools (Anthropic)

17. Menos tools, nombres con prefijo (`beel_*`), errores accionables (el server ya
    devuelve "Missing required path parameter account_id" — eso guía al agente),
    paginación por defecto, y describir el orden de descubrimiento (identity → account
    → companies) en descriptions/prompts para que el agente no se atasque en el primer
    path param.
