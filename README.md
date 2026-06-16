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
- **Interactive PDF viewer (MCP Apps)** — calling `beel_generate_invoice_pdf` opens the
  invoice PDF in a side panel in hosts that support MCP Apps (Claude, ChatGPT, …).

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

## Remote mode (OAuth) — hosting at `mcp.beel.es`

Besides the local stdio binary, the package ships a **remote HTTP server**
(`beel-mcp-http`) that speaks the **Streamable HTTP** transport and acts as an
**OAuth 2.1 Resource Server** in front of BeeL's authorization server. This is what
you'd deploy at `https://mcp.beel.es` for a hosted, multi-tenant connector.

How auth works:

1. A client connects without a token → `401` with
   `WWW-Authenticate: …resource_metadata=https://mcp.beel.es/.well-known/oauth-protected-resource/mcp`.
2. The client reads that metadata, discovers BeeL's authorization server, and runs
   the standard `authorization_code` + PKCE flow against `app.beel.es/oauth2/*`.
3. The client retries with a Bearer **JWT** (RS256). The server validates it offline
   via BeeL's JWKS (`/oauth2/jwks`), checks issuer/expiry/scopes, and **forwards the
   token to the BeeL API** — so every session acts with its own user's credentials.
   The environment (production vs sandbox) comes from the token's `environment` claim
   (the `sandbox` scope), not a key prefix.

```bash
npm run start:http   # serves on :$PORT (default 3000)
npm run test:oauth   # end-to-end OAuth flow against a local JWKS (no BeeL login needed)
```

### Remote env vars

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000). |
| `MCP_PUBLIC_URL` | Public URL of this server (default `https://mcp.beel.es`), used in the advertised resource metadata. |
| `BEEL_OAUTH_ISSUER` | BeeL OAuth issuer (default `https://app.beel.es`). The authorize/token/jwks/revoke URLs derive from it but can be overridden individually (`BEEL_OAUTH_AUTHORIZE_URL`, `…_TOKEN_URL`, `…_JWKS_URL`, `…_REVOKE_URL`). |
| `BEEL_BASE_URL` | API base the validated token is forwarded to (default `https://app.beel.es/api`). |

> **Client registration.** BeeL's OAuth client registration is currently manual
> (it@beel.es); the server does not yet expose Dynamic Client Registration. Clients
> that require DCR for "click & connect" need a pre-registered `client_id` or DCR added
> to the BeeL auth server.
>
> **Sessions** are held in memory (single instance). Behind a load balancer, route by
> the `mcp-session-id` header (sticky sessions) or add a shared session store.

## Interactive PDF viewer (MCP Apps)

`beel_generate_invoice_pdf` is an **MCP App** ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)):
when the agent calls it, the host renders the invoice PDF in a side panel. Mechanics:

- The tool carries `_meta.ui.resourceUri = "ui://beel/invoice-pdf.html"` and returns the
  PDF info as `structuredContent` (`download_url`, `file_name`, `expires_in_seconds`).
- The `ui://beel/invoice-pdf.html` resource (mimetype `text/html;profile=mcp-app`) serves a
  self-contained app (built from `src/ui/invoice-pdf-app.ts` with `@modelcontextprotocol/ext-apps`)
  that receives the result via the app-bridge and shows the PDF in a sandboxed iframe.
- Hosts that render MCP Apps today: Claude (claude.ai / Desktop via connectors), ChatGPT,
  VS Code, Goose, Postman, MCPJam.

The presigned PDF URL is a MinIO/S3 link, so its host must be allowed in the iframe CSP.
Set `BEEL_PDF_DOMAINS` (comma-separated origins) per environment; default
`https://minio.beel.es,https://app.beel.es`.

The UI is bundled by `npm run build:ui` (part of `npm run build`) into `dist/ui/invoice-pdf.html`.

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
  serve-http.ts         # remote HTTP (OAuth) entry point — beel-mcp-http
  server.ts             # wires tools / resources / prompts onto the MCP Server
  config.ts             # API key + env + base URL resolution
  http/
    client.ts           # auth, idempotency, Beel-Active-Company, error normalisation
    oauth.ts            # JWKS token verifier, OAuth metadata, token -> config
    serve.ts            # express app: discovery + bearer auth + session transports
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
  resources/
    guardrails.ts       # fiscal guardrails as MCP resources
    pdf-app.ts          # serves the ui:// PDF viewer resource (+ CSP)
  ui/
    registry.ts         # MCP Apps wiring (which tools get a UI panel, CSP domains)
    invoice-pdf-app.ts  # browser app (bundled into dist/ui/invoice-pdf.html)
  prompts/workflows.ts
```

## License

Proprietary — © BeeL.
