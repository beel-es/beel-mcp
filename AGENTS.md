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

- `src/spec/` — loads the OpenAPI contract (`openapi/public-api.yaml`) and derives the operation manifest, and the compact schema declarations `beel_schema_get` serves (`declarations.ts`). The contract is synced from the API, never edited by hand.
- `src/policy/` — which operations become tools (`tool-policy.ts`) and which scopes they need (`scopes.ts`). Least privilege: never add a scope no tool uses.
- `src/guardrails/` — the fiscal invariants checked before a request leaves (`validate.ts`), the API usage guides as markdown (`rules/`), and the error catalogue (`catalog.ts`).
- `src/rules/` — the fiscal rules catalogue, read from `docs.beel.es/api/rules.json`. `snapshot.json` is only its offline fallback, written by `npm run sync:rules`; never edit it, and never re-type a rule anywhere else.
- `src/sdks/` — the catalogue of official SDKs, read from `docs.beel.es/api/sdks.json` and reported by `beel_get_setup_status`. `snapshot.json` is its offline fallback, written by `npm run sync:sdks`; which SDK serves which stack is never written in prose here.
- `src/docs/catalogue.ts` — the loader both catalogues share: live, then stale, then the snapshot.
- `src/tools/` — API tools, docs tools, rules tools, the schema tool, workflow tools; `src/prompts/` — the workflow prompts.
- `src/server.ts` — the MCP server (stdio and remote share it); `src/index.ts` — the stdio entrypoint.
- `src/cf/` — the Cloudflare Worker: OAuth bridge (`beel-handler.ts`), token exchange, PDF relay. `/mcp` is a protected resource: every request without a token, `initialize` included, is answered by the OAuth provider with a 401 and its challenge. Deployment notes in `DEPLOY.md`.
- `src/mcpapp/` — the invoice viewer MCP App and its CSP contract.
- `tests/` — vitest; one file per module. A behaviour change without a test is not done.

## Rules that are not negotiable

- **The API is the authority.** A guardrail mirrors a rejection the API already makes; never invent fiscal rules here.
- **No secrets, no infrastructure in code.** Credentials come from the environment (`src/shared/defaults.ts` lists every variable); `wrangler.jsonc` holds only non-secret configuration.
- **Do not hand-edit the contract or the lock.** `npm run sync:spec` and `npm run spec:lock` are the only way it changes.
- **Every string an agent reads is product copy.** Tool descriptions, guardrail hints and error remedies must be precise and short; no marketing.
- **Conventional Commits.** Releases are cut by release-please from the commit history.

## Token efficiency

An agent pays for this server twice: once per call, because every call re-reads
the whole conversation, and once per byte of every result, because each result
stays in that conversation for every later turn. The number of calls costs more
than the size of any one result. So:

- **Fewer calls, bounded outputs.** A tool that answers a question in one call beats
  two that answer it in halves; a result has a stated ceiling (`MAX_PAGE_CHARS`,
  `LIST_LIMIT`, `CONCISE_STATEMENT_CHARS`) and never grows without one.
- **Batch parameters.** A read that agents repeat takes a list (`ids` in
  `beel_rules_get`, `sections` in `beel_docs_get`, `names` in `beel_schema_get`),
  capped by a named constant.
- **Explicit truncation.** A cut result says it was cut, how many items it left out
  and the argument that returns them. A filtered checklist is not cut by default:
  an agent that cannot tell it saw part of a list treats it as all of it.
- **Concise by default.** `response_format: concise` carries what an agent needs to
  act; rationale, quotes and examples are for `detailed`.
- **Descriptions carry what builds the call.** An input-schema description keeps its
  first paragraph and the sentences that state a rule (`schemaDescription` in
  `src/spec/prose.ts`); a route quoted in prose becomes the tool that calls it
  (`src/spec/routes.ts`). The full text stays in the contract and the docs.
- **Compact JSON.** Payloads go through `jsonText` in `src/tools/tool-result.ts`,
  without indentation. Do not add another serializer.
- **Guidance lives once.** Which tool to use, in what order and how to batch is in
  `SERVER_INSTRUCTIONS`; a tool description says what the tool does and does not
  repeat it. `tests/agent-guidance.test.ts` holds both to that.
- **Actionable errors.** An error names what to send instead (the accepted arguments,
  the valid values), so the retry is one call and not a series of guesses.
- **Every output-size change comes with a test.** `tests/output-size.test.ts` holds the
  size budgets of the results agents read most; a change that breaks one shrinks the
  output or raises the budget with its reason.

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
