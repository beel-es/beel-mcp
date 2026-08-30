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

## This repository is public

Everything written here — PR titles and bodies, commit messages, review comments —
is permanent and read by anyone, and GitHub keeps every earlier edit of a PR body in
its history. Describe the change, not the internal context:

- No secret values and no secret **names** (environment variables, `wrangler secret`
  names, where a value is kept). Provisioning instructions belong in `DEPLOY.md`.
- No infrastructure that the code does not already expose: hosting or observability
  providers, account or project ids, DSNs, storage hosts, command output from
  `wrangler`, `dig` or dashboards.
- No incident narratives (what broke in production, when, for how long). State the
  defect and the fix.
- No private repositories, their PR numbers, or copied ticket text. A Linear id
  (`BEE-nnnn`) on its own is fine.
- No business context: customers, plans, billing, team.
- No session or dashboard URLs.

## Before opening a PR

`npm test && npm run typecheck && npm run lint && npm run format:check` clean, the change covered by a test, and the PR body says what an agent can now do that it could not before.
