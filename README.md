# @beel_es/mcp — BeeL Model Context Protocol server

An MCP server that exposes the [BeeL](https://beel.es) invoicing API to LLM agents.
Tools are **derived from the public OpenAPI spec** (so the surface stays in sync with
the API), curated by a **tool-inclusion policy** (not every endpoint makes sense for an
agent), and wrapped in **Spanish fiscal guardrails** (VeriFactu, NIF validation, the
invoice state machine, corrective invoices) so an agent doesn't generate non-compliant
operations. It also exposes a **docs search** tool over the BeeL documentation.

It is the MCP sibling of the [`@beel_es/cli`](../beel-cli): same spec-driven philosophy,
same docs source, different surface.

## What it provides

- **~80 API tools** generated from `openapi/public-api.yaml` — invoices, customers,
  products, recurring invoices, series & tax configuration, NIF validation, companies.
  Each tool's `inputSchema` is the operation's real JSON Schema (enums, line items,
  regime keys included), so the model sees the exact contract.
- **3 docs tools** — `beel_docs_search`, `beel_docs_get`, `beel_docs_list` — over
  `docs.beel.es` (fetched, cached, scored locally; no API quota spent).
- **Guardrail resources** under `beel://guardrails/*` — the fiscal invariants, also
  woven into the relevant tool descriptions.
- **Workflow prompts** — `issue-invoice`, `fix-invoice` — that encode the safe order of
  operations (validate NIF → choose F1/F2 → check VeriFactu gates → issue).

### What is *not* a tool (by policy)

The policy excludes operation classes an agent can't drive: binary downloads (PDF
preview, bulk ZIP, Excel/CSV export), multipart uploads (CSV/Holded import, signed-PDF
submission) and webhook infrastructure. See `src/policy/tool-policy.ts`.

## Install & configure

Requires Node ≥ 20. Run via `npx` (no install needed):

```jsonc
// Claude Desktop / Claude Code MCP config
{
  "mcpServers": {
    "beel": {
      "command": "npx",
      "args": ["-y", "@beel_es/mcp"],
      "env": {
        "BEEL_API_KEY": "beel_sk_test_xxx"
      }
    }
  }
}
```

### Environment variables

| Variable | Purpose |
|---|---|
| `BEEL_API_KEY` | API key. The prefix selects the environment: `beel_sk_test_` → sandbox, `beel_sk_live_` → production. **Sandbox is safe to experiment with.** |
| `BEEL_ACTIVE_COMPANY` | (Optional) Company UUID for multi-NIF accounts. Sent as `Beel-Active-Company`. List companies with `beel_list_companies`. |
| `BEEL_BASE_URL` | (Optional) Override the API base URL (default `https://app.beel.es/api`). |
| `BEEL_DOCS_URL` | (Optional) Override the docs source (default `https://docs.beel.es`), e.g. a local `beel-api-docs-standalone` instance. |
| `BEEL_ENV` / `BEEL_CONFIG_DIR` | (Optional) If `BEEL_API_KEY` is unset, the server falls back to the CLI's `~/.config/beel/config.json` (`beel login`); `BEEL_ENV` (`test`/`live`, default `test`) selects which stored key. |

If no key is configured the server still starts and lists tools — it only errors when an
API tool is actually called. POST calls send an `Idempotency-Key` automatically, so an
agent retry never duplicates an invoice.

## Development

```bash
npm install
npm run dev        # run from source over stdio (tsx)
npm test           # vitest: derive / manifest / policy / json-schema / guardrails
npm run typecheck
npm run build      # single-file bundle to dist/index.js
npm run inspect    # build + open the MCP Inspector
```

## Maintenance — keeping the spec in sync

The spec is interpreted at runtime, so syncing it is the whole maintenance story:

```bash
npm run sync:spec  # re-bundle openapi/public-api.yaml from the sibling backend checkout
npm test           # confirm the manifest/policy still hold
```

The spec source is the **`develop`** branch of the backend repo. CI (`sync-spec.yml`)
does this automatically on a `repository_dispatch` from the backend, runs the test suite,
commits the new spec to `develop`, and publishes a patch release to npm.

> The bundle keeps internal `$ref`s (it is **not** fully dereferenced) — a dereferenced
> bundle produces a YAML-alias explosion that trips the parser. Schema refs are resolved
> into local `#/$defs` when building each tool's input schema.

## Architecture

```
src/
  index.ts              # stdio entry point
  server.ts             # wires tools / resources / prompts onto the MCP Server
  config.ts             # API key + env + base URL resolution
  http/client.ts        # auth, idempotency, Beel-Active-Company, error normalisation
  spec/
    load.ts             # parse the embedded OpenAPI doc
    refs.ts             # JSON-Pointer $ref resolution
    manifest.ts         # operations -> OperationSpec[] (params, body, response info)
    derive.ts           # operationId -> beel_snake_case tool name
    json-schema.ts      # OperationSpec -> MCP inputSchema (refs -> #/$defs)
  policy/
    tool-policy.ts      # curated include/exclude rules
    annotations.ts      # readOnly / destructive / idempotent hints
  guardrails/
    domain.ts           # the fiscal invariants (state machine, F1/F2/R1–R5, regime keys…)
    enrich.ts           # map operations -> guardrails, inject into descriptions
  docs/
    fetch.ts            # fetch + cache docs.beel.es/llms*.txt
    search.ts           # chunk + keyword scoring
  tools/                # api-tools (spec-derived) + docs-tools
  resources/guardrails.ts
  prompts/workflows.ts
```

## License

Proprietary — © BeeL.
