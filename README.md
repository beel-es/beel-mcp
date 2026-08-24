<p align="center">
  <a href="https://beel.es">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://docs.beel.es/docs-static/beel-logo-dark.svg">
      <img src="https://docs.beel.es/docs-static/beel-logo.svg" alt="BeeL" width="220">
    </picture>
  </a>
</p>

<h1 align="center">BeeL MCP server — VeriFactu e-invoicing for AI agents</h1>

<p align="center">
  Servidor <strong>MCP de facturación electrónica</strong> española con <strong>VeriFactu</strong> (AEAT): crea, emite y rectifica facturas desde <strong>Claude, ChatGPT, Cursor o VS Code</strong>.<br>
  <strong>MCP server for Spanish e-invoicing</strong> with <strong>VeriFactu</strong> compliance — issue, correct and register invoices with AEAT straight from your AI agent.<br>
  <a href="https://beel.es">beel.es</a> · <a href="https://docs.beel.es">API docs</a> · <a href="https://docs.beel.es/mcp">MCP guide</a> · <a href="https://www.npmjs.com/package/@beel_es/mcp">npm</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@beel_es/mcp"><img src="https://img.shields.io/npm/v/@beel_es/mcp.svg" alt="npm version"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/Model_Context_Protocol-server-224DA9" alt="MCP server"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets an AI
agent issue **legally compliant Spanish electronic invoices** — **VeriFactu** registration
with **AEAT**, F1/F2 invoice types, R1–R5 correctives, NIF validation against the census,
and the regime keys the regulation requires. Connect it to **Claude, ChatGPT, Cursor or
VS Code** and your agent can handle Spanish invoicing — *facturación electrónica* and
*factura electrónica VeriFactu* — end to end, without you writing a single API call.

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

One codebase, two transports: the hosted **remote server** at
`https://mcp.beel.es/mcp` (Streamable HTTP + OAuth — one login per user, nothing to
install), and a **local stdio** server built from this repository for headless use, where
an API key works and a browser-based login does not.

## Quick start

Add **`https://mcp.beel.es/mcp`** as a connector in Claude, ChatGPT, Cursor or VS Code and
log in with your BeeL account. Nothing to install and no API key to handle: the server acts
with your own credentials, and the OAuth flow is discovered from the URL.

```bash
# Claude Code
claude mcp add --transport http beel https://mcp.beel.es/mcp
```

That is the whole setup for interactive use. Read on only if you need the local server.

## Running it locally

Use the local server when OAuth cannot: a scheduled job that issues invoices, a CI
pipeline, or any headless process where no one is present to complete a browser login.
It authenticates with an API key instead.

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

Keys prefixed `beel_sk_test_` are safe to experiment with; `beel_sk_live_` issues real
fiscal documents.

Releases are published from CI through npm [trusted
publishing](https://docs.npmjs.com/trusted-publishers), so they carry provenance: npm
records the exact commit and workflow each build came from. Verify it with `npm audit
signatures`.

Each release is also announced to the [MCP
Registry](https://registry.modelcontextprotocol.io) as
`io.github.beel-es/beel-mcp`, listing both transports, so clients that browse the
registry find the server without being pointed at it.

## What it provides

- **119 API tools** derived from `openapi/public-api.yaml` — invoices, customers,
  products, recurring invoices, series and tax configuration, NIF validation, companies.
- **4 synthetic tools** the API has no single endpoint for: `beel_docs_search`,
  `beel_docs_get`, `beel_docs_list` over the documentation, and
  `beel_get_setup_status`, which reports per NIF exactly what is missing before it can
  issue and the one next action to take.
- **Guardrail resources** under `beel://guardrails/*` — the fiscal invariants, plus
  `beel://guardrails/errors`, a catalogue of every error code with the action it calls
  for. Their summaries are woven into the description of every tool they constrain.
- **7 workflow prompts** encoding the safe order of operations for the flows where the
  order is what makes them safe: `issue-invoice` (validate NIF → choose F1/F2 → check the
  VeriFactu gates → issue), `fix-invoice` (void vs correct), `onboard-nif`,
  `setup-representation`, `invite-member`, `connect-payments` and `upgrade-integration`.
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

Spanish e-invoicing has invariants an LLM will get wrong from the schema alone — voiding
an invoice that should have been corrected, using R1 on a simplified invoice, editing one
AEAT has already registered. The server addresses that in three layers, and the difference
between them matters:

**1. Advisory** — `src/guardrails/rules/*.md`, one Markdown file per topic: the invoice
lifecycle, void vs rectify, invoice types, invoice lines, regime keys, series numbering,
NIF validation, the VeriFactu gates, multi-NIF accounts. Each is exposed as an MCP
resource under `beel://guardrails/*` and its one-line summary is appended to the
description of every tool it constrains, so the constraint travels with the call.

**2. Enforced** — `src/guardrails/validate.ts`, checked before the request is sent, so a
bad payload never even consumes an idempotency key:

| Check | Code |
|---|---|
| Exactly one pricing field per line | `LINE_UNIT_PRICE_XOR_DECLARED_TOTAL` |
| No discount on a declared total | `LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT` |
| No IRPF withholding on a simplified (F2) invoice | `SIMPLIFICADA_FORBIDS_IRPF` |
| Equivalence surcharge only under regime `18`, and `18` only with one | `SURCHARGE_REQUIRES_REGIME` / `REGIME_REQUIRES_SURCHARGE` |
| Series format can tell its reset periods apart | `SERIES_ANNUAL_REQUIRES_YEAR` / `SERIES_MONTHLY_REQUIRES_MONTH_AND_YEAR` |
| Numbering is only seeded in the call that activates the company | `NUMBERING_REQUIRES_ACTIVATION` |
| `SUPLIDO` lines carry their source reference | checked locally |
| Exemption text only under reason `OTRO` | checked locally |
| Correctives go through their own operation, not `type: CORRECTIVE` | checked locally |

**3. Explained** — the BeeL API already answers well: its `message` is written for a
human in the caller's language, `error.details` carries the specifics, and the RFC 7807
`type` field links to a documentation page for that exact code (around 357 of them). The
server relays all of that untouched, and adds only the two things a response cannot
carry: **the remedy as a tool call** — the docs address someone with the dashboard open
("create a series in settings"), an agent needs `beel_set_default_series` — and
**whether retrying can possibly help**, which is what stops an agent looping on a 403
that needs an administrator. `src/guardrails/catalog.ts` holds only codes where one of
those applies; anything else passes through, because a paraphrase would be worse than the
original and would drift from it. The nested `blockers[]` of `EMISSION_NOT_READY` are the
clearest case: they arrive as bare strings with no message and no link, and each comes
back out naming the tool that clears it.

**The BeeL API is the authority on all of it.** Every enforced rule mirrors a rejection
the contract documents, so the pre-flight is a strict subset of what the API refuses: it
can only make failure faster and better explained, never permit something the API would
reject. Rules that depend on server-side state — AEAT census matching, the €3 000 F2
ceiling, whether a series exists — stay advisory on purpose, because guessing at them
locally would reject valid invoices. Set `BEEL_DISABLE_PREFLIGHT=1` to bypass the local
checks entirely.

Hand-curated lists are anchored by tests: every catalogued code must still appear in the
contract, every checked `operationId` must still resolve to a real tool, and every
guardrail reference must point at a guardrail that exists. An API rename fails CI instead
of silently switching a fiscal check off.

## Configuration

### Local server only

| Variable | Purpose |
|---|---|
| `BEEL_API_KEY` | API key. The prefix selects the environment: `beel_sk_test_` → Test, `beel_sk_live_` → Live. |
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
npm run typecheck    # both the Node and the Worker configs
npm run build        # single-file bundle to dist/index.js
npm run inspect      # MCP Inspector against the local build
npm run spec:verify  # the vendored contract still matches its lock
```

`openapi/public-api.yaml` is a **generated** copy of the API contract, and
`openapi/spec.lock.json` records its version, operation count and hash. CI fails if the
two disagree, which is what keeps a vendored contract honest. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## The rest of the BeeL developer ecosystem

Everything below derives from the same OpenAPI contract, so the vocabulary — invoice
types, regime keys, series, VeriFactu states — is identical wherever you meet it.

| | |
|---|---|
| [**REST API**](https://docs.beel.es) | The contract itself. Everything else is a projection of it |
| [**CLI**](https://docs.beel.es/cli) | The same surface from a terminal, sandbox by default |
| [**n8n node**](https://docs.beel.es/tools) | Invoicing inside a no-code workflow |
| [**Claude Code plugin**](https://docs.beel.es/claude-code) | Implement, audit and maintain a BeeL integration |
| [**Machine-readable docs**](https://docs.beel.es/llms.txt) | `llms.txt` for agents that would rather read than guess |

## FAQ

**What is the BeeL MCP server?**
An [MCP](https://modelcontextprotocol.io) server that exposes Spanish VeriFactu e-invoicing
as tools an AI agent can call — so Claude, ChatGPT, Cursor or VS Code can create customers,
issue F1/F2 invoices, register them with AEAT, and post R1–R5 correctives on your behalf.

**How do I connect VeriFactu invoicing to Claude / ChatGPT / Cursor?**
Add `https://mcp.beel.es/mcp` as a connector and log in with your BeeL account — see
[Quick start](#quick-start). Nothing to install, and no API key to paste for interactive use.

**Is it actually VeriFactu-compliant?**
Yes. Invoices are registered with AEAT under VeriFactu, numbering and series follow the
regulation, and the [fiscal guardrails](#the-fiscal-guardrails) stop non-compliant requests
before they ever become a fiscal document.

**VeriFactu or TicketBAI?**
This server targets **VeriFactu**, the national AEAT system. TicketBAI (the Basque Country
regime) is out of scope.

**Can I use it without an AI agent?**
Yes — it is a standard MCP server, so any MCP-capable client works, and the same invoicing
surface is available as a [REST API, CLI and n8n node](#the-rest-of-the-beel-developer-ecosystem).

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for
how the project is laid out and which conventions are load-bearing. Security issues go to
**security@beel.es** rather than a public issue; see [SECURITY.md](./SECURITY.md).

## License

MIT © [BeeL.](https://beel.es)

<div align="center">
<br>
<a href="https://beel.es">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://docs.beel.es/docs-static/beel-logo-dark.svg">
    <img src="https://docs.beel.es/docs-static/beel-logo.svg" alt="BeeL" width="120">
  </picture>
</a>
<p><sub><a href="https://beel.es">beel.es</a> · <a href="https://docs.beel.es">Documentación</a> · <a href="https://docs.beel.es/mcp">Guía del MCP</a></sub></p>
</div>
