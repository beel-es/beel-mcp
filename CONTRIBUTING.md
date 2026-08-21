# Contributing

## Getting set up

```bash
npm ci
npm test          # vitest
npm run typecheck # tsc, both the Node and Worker configs
npm run inspect   # MCP Inspector against the local stdio server
```

You do not need BeeL credentials to build, test or list tools — only to actually
call the API.

## The one rule that matters

**`openapi/public-api.yaml` is generated. Never edit it by hand.**

It is a vendored copy of the contract the BeeL API is built from, and the entire
tool surface is derived from it. Editing it makes every tool advertise a contract
the API does not honour. CI enforces this: `npm run spec:verify` compares the file
against `openapi/spec.lock.json` and fails on any change that did not come from a
sync. After a legitimate sync, regenerate the lock in the same commit with
`npm run spec:lock`.

## Where things live

| Path | What it owns |
|---|---|
| `src/spec/` | Reading the OpenAPI document and projecting it to JSON Schema |
| `src/policy/` | Which operations become tools, their annotations, and OAuth scopes |
| `src/guardrails/rules/*.md` | The fiscal prose surfaced to agents — plain Markdown |
| `src/guardrails/validate.ts` | The invariants actually enforced before a call |
| `src/tools/` | Tool definitions, argument validation, result shaping |
| `src/api/` | The HTTP client (auth, idempotency, timeouts, retries) |
| `src/cf/` | The Cloudflare Worker: OAuth towards BeeL, the remote transport |
| `src/shared/defaults.ts` | Every shared constant. Nothing here may be duplicated |

## Conventions worth knowing

- **No constant lives in two places.** Endpoints, client ids, header names, TTLs
  and environment-variable names all come from `src/shared/defaults.ts`. This is
  not style: two scope lists in two files once drifted apart and sent clients to
  consent for scopes the backend rejected.
- **No infrastructure in code.** Storage hosts, KV ids, routes and secrets are
  environment configuration. If you find yourself typing a hostname into a `.ts`
  file, add an environment variable to `ENV_VAR` instead.
- **Adding an executable guardrail** (`src/guardrails/validate.ts`) requires that
  the API documents the same rejection, with its error code. The pre-flight must
  stay a strict subset of what the API rejects, or it will block valid invoices.
  Advisory-only rules belong in `src/guardrails/rules/*.md`.
- **Hand-curated operationId lists** (destructive operations, guardrail bindings)
  must be covered by a test that fails when an id stops resolving. API migrations
  rename operationIds, and a stale entry fails silently otherwise.

## Pull requests

Keep the diff to one concern. Include a test for any behaviour change — the fiscal
rules especially, where a regression is a wrong invoice rather than a wrong pixel.
