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
| `src/guardrails/rules/*.md` | The fiscal prose surfaced to agents — Markdown, with its own front matter |
| `src/guardrails/validate.ts` | The invariants actually enforced before a call |
| `src/guardrails/catalog.ts` | Error code → what it means and what to do about it |
| `src/guardrails/explain.ts` | Renders an API error through that catalogue |
| `src/tools/` | Tool definitions, argument validation, result shaping |
| `src/api/` | The HTTP client (auth, idempotency, timeouts, retries) |
| `src/cf/` | The Cloudflare Worker: OAuth towards BeeL, the remote transport |
| `src/shared/defaults.ts` | Every shared constant. Nothing here may be duplicated |

## Conventions worth knowing

- **No constant lives in two places.** Endpoints, client ids, header names, TTLs
  and environment-variable names all come from `src/shared/defaults.ts`. This is
  not a style rule: two copies of the same list are two things to remember, and
  the failure when they disagree shows up in the OAuth consent screen rather
  than in a test.
- **No infrastructure in code.** Storage hosts, KV ids, routes and secrets are
  environment configuration. If you find yourself typing a hostname into a `.ts`
  file, add an environment variable to `ENV_VAR` instead.
- **The three guardrail layers are not interchangeable.** Prose that a model reads
  goes in `rules/*.md`. A rule enforced before the request is sent goes in
  `validate.ts`, and only if the contract documents the same rejection — the
  pre-flight must stay a strict subset of what the API refuses, or it will block
  valid invoices. What an error code means and what to do about it goes in
  `catalog.ts`, never inlined at a call site, so that the same code always reads
  the same way to an agent no matter which layer caught it.
- **A new guardrail is one Markdown file.** Add `rules/<id>.md` with `title`,
  `docPath` and `summary` front matter, register it in `rules.ts`, and map the
  operations it constrains in `enrich.ts`. No metadata lives outside the file.
- **Hand-curated operationId lists** (destructive operations, guardrail bindings)
  must be covered by a test that fails when an id stops resolving. API migrations
  rename operationIds, and a stale entry fails silently otherwise.

## How it ships

Three workflows, and none of them overlap:

| What | Trigger | Does |
|---|---|---|
| `ci.yml` | every push and pull request | contract lock, typechecks, tests, build, stdio smoke test. Uses no secrets, so it is safe on pull requests from forks |
| `sync-spec.yml` | `repository_dispatch` from the backend | re-bundles the contract, refreshes the lock, commits |
| Cloudflare Workers Builds | push to the production branch | builds and deploys the Worker |

Workers Builds must have **"Builds for non-production branches" disabled**; see
[DEPLOY.md](./DEPLOY.md#required-build-configuration).

## Releasing

```bash
npm version <patch|minor|major>
git push --follow-tags
```

`npm run verify:package` packs the tarball, installs it into a temporary
directory and drives the installed binary over the protocol. It is the only
check that sees what a consumer actually receives — the smoke tests run
`dist/index.js` directly, so they cannot tell whether a file was packed.

The tag triggers `publish.yml`, which re-runs the contract check, the typechecks, the
tests and a smoke test of the built binary before publishing. It refuses to publish when
the tag and `package.json` disagree.

There is **no npm token**. Authentication is [trusted
publishing](https://docs.npmjs.com/trusted-publishers): GitHub mints a short-lived,
workflow-specific OIDC token that npm verifies against the publisher configured for this
package, and npm attaches provenance automatically.

### First-time setup

Trusted publishing cannot bootstrap itself: npm requires the package to **already exist**
on the registry before a trusted publisher can be attached to it. So the first version is
published by hand, once, and every version after that comes from CI.

```bash
# 1. Authenticate interactively. Two-factor authentication must be enabled on the
#    account — trusted publishing requires it.
npm login

# 2. Publish the first version from a clean checkout. This one has no provenance;
#    every later release does, because provenance comes from the CI environment.
npm ci && npm publish

# 3. Attach the trusted publisher (npm >= 11.15.0):
npx npm@latest trust github @beel_es/mcp \
  --repo beel-es/beel-mcp \
  --file publish.yml \
  --allow-publish
```

Step 3 can also be done through npmjs.com → the package → **Settings → Trusted
Publisher**:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization | `beel-es` |
| Repository | `beel-mcp` |
| Workflow filename | `publish.yml` |
| Environment | *(empty)* |

Verify it took with `npm trust list @beel_es/mcp`. After that no credential is involved
in a release, and none needs storing anywhere.

### The MCP Registry

After npm, the same workflow announces the release to the [MCP
Registry](https://registry.modelcontextprotocol.io) from `server.json`, which lists both
the npm package and the hosted server.

The server is listed as `es.beel/mcp`. That namespace comes from the domain, not from this
repository: `mcp-publisher login dns` signs a timestamp with an ed25519 key whose public
half is a TXT record on the apex of `beel.es`, declared in `beel-infra`.

```
beel.es  TXT  "v=MCPv1; k=ed25519; p=<base64 public key>"
```

It has to sit on the apex — the registry rejects the same value under a selector such as
`_mcp-auth.beel.es`, and says so.

The private half is the seed, hex-encoded, in the `MCP_DNS_PRIVATE_KEY` secret of the
`npm-publish` environment — so it is reachable only after the same human approval that
gates npm. It is the one credential in the release: npm needs none, but a domain namespace
cannot work without proof only the domain holder can produce. Rotating it means publishing
a new public key in `beel-infra` **and** replacing the secret; do one without the other and
releases stop.

The claim runs both ways: `server.json` names the npm package, and `package.json`
names the server back through `mcpName`. The registry reads that field out of the
*published* tarball to confirm the package really belongs to this server, so a missing
or mismatched `mcpName` fails the release — and fails it late, after npm has already
published, since the check needs the package to exist. `manifest:verify` asserts it
here instead, where it costs nothing.

`server.json` is hand-written except for the version, which is derived from
`package.json` — the registry refuses to republish a version it already holds, so a stale
manifest would fail the release. `npm version` regenerates it and stages it in the same
commit via the `version` lifecycle script; CI verifies it did (`npm run manifest:verify`),
and the release validates the manifest against the live registry before publishing
anything.

To change what the registry shows — description, transports, environment variables — edit
`server.json` and check it with `mcp-publisher validate`. The name is a public identifier:
renaming it strands the existing listing rather than moving it.

The server was listed as `io.github.beel-es/beel-mcp` up to v0.2.2, before the domain
namespace existed. That listing had to be **deleted**, not deprecated:

```bash
mcp-publisher login github --token "$(gh auth token)"
mcp-publisher status --status deleted --all-versions io.github.beel-es/beel-mcp
```

A remote URL may belong to only one server, and the check that enforces it filters on
`status != 'deleted'` and nothing else — so a deprecated listing goes on holding
`https://mcp.beel.es/mcp` and the new name cannot claim it. Deprecating first is the
obvious move and it fails, with an error that names the old server without saying why it
still counts.

Note the auth: the old name lives under `io.github.beel-es`, so retiring it needs GitHub
auth, not the DNS key. `login github --token` takes a PAT and avoids the interactive
device flow.

## Pull requests

Keep the diff to one concern. Include a test for any behaviour change — the fiscal
rules especially, where a regression is a wrong invoice rather than a wrong pixel.
