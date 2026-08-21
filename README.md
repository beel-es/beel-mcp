# BeeL MCP server — VeriFactu-compliant invoicing for AI agents

[![CI](https://github.com/beel-es/beel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/beel-es/beel-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@beel_es/mcp.svg)](https://www.npmjs.com/package/@beel_es/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent issue **legally
compliant Spanish electronic invoices** — VeriFactu registration with AEAT, F1/F2 invoice
types, R1–R5 correctives, NIF validation against the census, and the regime keys the
regulation requires.

It is not a generated wrapper around an API. Three things make it usable by a model:

- **Tools are derived from the public OpenAPI contract**, so each tool's input schema is
  the operation's real schema — enums, line items, regime keys and all. The surface
  cannot drift from the API.
- **A tool-inclusion policy** decides what an agent should actually be given. Binary
  downloads, multipart uploads, webhook plumbing and deprecated operations are excluded
  by rule, not by hand.
- **Fiscal guardrails** travel with the tools: the invariants a generated wrapper would
  miss, both as documentation the model reads and as pre-flight checks that stop a
  non-compliant request before it becomes a fiscal document.

Two transports, one codebase: a local **stdio** binary (`npx @beel_es/mcp`, API key) and a
hosted **remote server** at `https://mcp.beel.es` (Streamable HTTP + OAuth, one login per
user, no key to paste).

## Quick start

### Remote (recommended)

Add `https://mcp.beel.es` as a connector in Claude, ChatGPT, Cursor or VS Code and log in
with your BeeL account. Nothing to install, no API key to handle; the server acts with
your own credentials.

### Local (stdio)

Requires Node ≥ 20.

```jsonc
// Claude Desktop / Claude Code MCP config
{
  "mcpServers": {
    "beel": {
      "command": "npx",
      "args": ["-y", "@beel_es/mcp"],
      "env": { "BEEL_API_KEY": "beel_sk_test_xxx" }
    }
  }
}
```

```bash
# Claude Code
claude mcp add beel --env BEEL_API_KEY=beel_sk_test_xxx -- npx -y @beel_es/mcp
```

Keys prefixed `beel_sk_test_` are safe to experiment with. `beel_sk_live_` issues real
fiscal documents.

## What it provides

- **119 API tools** derived from `openapi/public-api.yaml` — invoices, customers,
  products, recurring invoices, series and tax configuration, NIF validation, companies.
- **4 synthetic tools** the API has no single endpoint for: `beel_docs_search`,
  `beel_docs_get`, `beel_docs_list` over the documentation, and
  `beel_get_setup_status`, which reports per NIF exactly what is missing before it can
  issue and the one next action to take.
- **Guardrail resources** under `beel://guardrails/*` — the fiscal invariants, also woven
  into the description of every tool they constrain.
- **Workflow prompts** — `issue-invoice`, `fix-invoice` — encoding the safe order of
  operations (validate NIF → choose F1/F2 → check VeriFactu gates → issue).
- **Inline invoice PDF viewer** ([MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)):
  generating an invoice PDF opens it in a side panel in hosts that support it.

A generated catalogue of every tool, with the scopes each requires, lives at
[docs.beel.es/mcp/tools](https://docs.beel.es/mcp/tools) (`npm run tools:catalog`).

### What is deliberately not a tool

Binary downloads (PDF preview, bulk ZIP, Excel/CSV export), multipart uploads (CSV/Holded
import, signed-PDF submission), webhook infrastructure, and every `deprecated` operation.
An agent cannot drive them, and each one costs context that a usable tool needs. The rules
are in `src/policy/tool-policy.ts`.

## The fiscal guardrails

Spanish e-invoicing has invariants that an LLM will get wrong from the schema alone —
choosing to void an invoice when it should be corrected, using R1 on a simplified invoice,
editing an invoice that AEAT has already registered. The server handles them at two
distinct levels, and the difference matters:

**Advisory** (`src/guardrails/rules/*.md`) — prose read by the model. The invoice state
machine, void vs rectify, F1/F2/R1–R5, regime keys, NIF validation, the VeriFactu
submission gates, multi-NIF accounts. Exposed as MCP resources and appended to the
description of each tool they apply to.

**Enforced** (`src/guardrails/validate.ts`) — checked before the request leaves the
process, so a bad payload never even consumes an idempotency key:

| Check | API error code |
|---|---|
| Exactly one pricing field per line | `LINE_UNIT_PRICE_XOR_DECLARED_TOTAL` |
| No discount on a declared total | `LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT` |
| No IRPF withholding on a simplified (F2) invoice | `SIMPLIFICADA_FORBIDS_IRPF` |
| Equivalence surcharge only under regime `18`, and `18` only with one | `SURCHARGE_REQUIRES_REGIME` / `REGIME_REQUIRES_SURCHARGE` |
| `SUPLIDO` lines carry their source reference | — |
| Correctives go through their own operation, not `type: CORRECTIVE` | — |

**The BeeL API is the authority on all of it.** Every enforced rule is a strict subset of
a rejection the API documents, so the pre-flight can only make failure faster and better
explained — never permit something the API would refuse. Rules that depend on server-side
state (AEAT census matching, the €3 000 F2 ceiling, VeriFactu gates) stay advisory on
purpose: guessing them locally would reject valid invoices. Set `BEEL_DISABLE_PREFLIGHT=1`
to bypass the local checks entirely.

## Configuration

### Local (stdio)

| Variable | Purpose |
|---|---|
| `BEEL_API_KEY` | API key. The prefix selects the environment: `beel_sk_test_` → Test, `beel_sk_live_` → Live. |
| `BEEL_ACTIVE_COMPANY` | Optional. Company UUID for multi-NIF accounts, sent as `Beel-Active-Company`. List them with `beel_list_companies`. |
| `BEEL_ENV` / `BEEL_CONFIG_DIR` | Optional. With `BEEL_API_KEY` unset, falls back to the CLI's `~/.config/beel/config.json` (`beel login`); `BEEL_ENV` (`test`/`live`, default `test`) picks which stored key. |

### Shared

| Variable | Purpose |
|---|---|
| `BEEL_BASE_URL` | API base URL. Default `https://app.beel.es/api`. |
| `BEEL_DOCS_URL` | Documentation source for the docs tools. Default `https://docs.beel.es`. |
| `BEEL_REQUEST_TIMEOUT_MS` | Hard ceiling on a single API call. Default `30000`. |
| `BEEL_DISABLE_PREFLIGHT` | Set to `1` to skip the enforced guardrails. |

Every default lives in `src/shared/defaults.ts`; nothing is hardcoded twice. Remote
deployment variables are documented in [DEPLOY.md](./DEPLOY.md).

The server starts and lists tools with no credentials at all — it only errors when an API
tool is actually called. POST requests carry a stable `Idempotency-Key` derived from the
request itself, so an agent retrying "create invoice" can never mint a second invoice.

## Self-hosting

The remote server runs on Cloudflare Workers. See [DEPLOY.md](./DEPLOY.md) for the KV
namespace, the OAuth client BeeL must have registered, and the secrets involved.

## Development

```bash
npm ci
npm run dev          # stdio server from source
npm test             # vitest
npm run typecheck    # Node and Worker configs
npm run build        # single-file bundle to dist/index.js
npm run inspect      # MCP Inspector against the local build
npm run spec:verify  # the vendored contract still matches its lock
```

`openapi/public-api.yaml` is a **generated** copy of the API contract, and
`openapi/spec.lock.json` records its version, operation count and hash. CI fails if the
two disagree, which is what keeps a vendored contract honest. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Related

- [`@beel_es/cli`](https://docs.beel.es/cli) — the same contract from the terminal
- [BeeL API reference](https://docs.beel.es) · [MCP guide](https://docs.beel.es/mcp)
- [Security policy](./SECURITY.md)

## License

MIT © BeeL
