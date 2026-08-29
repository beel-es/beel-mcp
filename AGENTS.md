# AGENTS.md — working on this repository with a coding agent

This is the BeeL MCP server: Spanish e-invoicing (VeriFactu) tools for LLM agents,
derived from the public OpenAPI contract. Read `README.md` for what it does and
`CONTRIBUTING.md` for the rules; this file is the short version an agent needs before
touching code.

## Commands

```bash
npm ci
npm test            # vitest — must stay green
npm run typecheck   # tsc for both the Node and the Worker configs
npm run lint        # eslint
npm run format      # prettier --write (CI runs format:check)
npm run build       # tsup + the MCP App bundle (dist/mcpapp/invoice-pdf.html)
npm run smoke       # boots dist/index.js and asserts tools/list
npm run tools:list  # every tool the server exposes, with its scopes
```

## Where things live

- `src/spec/` — loads the OpenAPI contract (`openapi/public-api.yaml`) and derives the operation manifest. The contract is synced from the API, never edited by hand.
- `src/policy/` — which operations become tools (`tool-policy.ts`) and which scopes they need (`scopes.ts`). Least privilege: never add a scope no tool uses.
- `src/guardrails/` — the fiscal invariants checked before a request leaves (`validate.ts`), the rules as markdown (`rules/`), and the error catalogue (`catalog.ts`).
- `src/tools/` — API tools, docs tools, workflow tools; `src/prompts/` — the workflow prompts.
- `src/server.ts` — the MCP server (stdio and remote share it); `src/index.ts` — the stdio entrypoint.
- `src/cf/` — the Cloudflare Worker: OAuth bridge (`beel-handler.ts`), public discovery, token exchange, PDF relay. Deployment notes in `DEPLOY.md`.
- `src/mcpapp/` — the invoice viewer MCP App and its CSP contract.
- `tests/` — vitest; one file per module. A behaviour change without a test is not done.

## Rules that are not negotiable

- **The API is the authority.** A guardrail mirrors a rejection the API already makes; never invent fiscal rules here.
- **No secrets, no infrastructure in code.** Credentials come from the environment (`src/shared/defaults.ts` lists every variable); `wrangler.jsonc` holds only non-secret configuration.
- **Do not hand-edit the contract or the lock.** `npm run sync:spec` and `npm run spec:lock` are the only way it changes.
- **Every string an agent reads is product copy.** Tool descriptions, guardrail hints and error remedies must be precise and short; no marketing.
- **Conventional Commits.** Releases are cut by release-please from the commit history.

## Before opening a PR

`npm test && npm run typecheck && npm run lint && npm run format:check` clean, the change covered by a test, and the PR body says what an agent can now do that it could not before.
