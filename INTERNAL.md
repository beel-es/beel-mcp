# Internal notes — not for the public repository

This file, `LEARNINGS.md`, `.github/workflows/sync-spec.yml` and
`wrangler.prod.local.jsonc` are the only things in this checkout that must not reach a
public mirror. Everything else has been scrubbed of infrastructure: hostnames, KV
namespace ids, routes and secrets are environment configuration, and
`src/shared/defaults.ts` holds only values already published in the docs.

## Why the public repo must be a fresh repository

Working tree cleanliness is not enough — git history is forever, and this repository's
history contains:

- the KV namespace id and the production route (`wrangler.jsonc`, all revisions),
- an internal storage hostname hardcoded in `src/cf/pdf-proxy.ts`,
- the private backend repository name and its deploy-key reference,
- `BEE-###` issue keys in every commit message.

So the public repository starts from a single squashed commit. That loses the history,
which nobody misses on a newly published repo, and is the only way to guarantee nothing
leaks.

## Publishing procedure

```bash
# 1. From a clean checkout of the branch you want to publish:
node scripts/public-export.mjs /tmp/beel-mcp-public

# 2. Review what is about to become public. Read it, do not skim it:
cd /tmp/beel-mcp-public && git show --stat HEAD && grep -rniE \
  'railway|minio|storage\.beel|BEE-[0-9]|carlosmgv|deploy_key|secrets\.' . \
  --exclude-dir=.git || echo "clean"

# 3. Create the public repo and push:
gh repo create beel-es/beel-mcp --public --source=. --remote=origin --push
```

Then, in the GitHub UI: set the topics (`mcp`, `model-context-protocol`, `verifactu`,
`facturacion-electronica`, `invoicing`, `spain`, `aeat`, `claude`, `llm-tools`), set the
description and the `https://docs.beel.es/mcp` website link, and enable issues.

## Keeping the two in sync afterwards

This repository stays private and keeps `sync-spec.yml` (which needs backend access). On
each release, re-run `scripts/public-export.mjs` and push the result as a new commit to
the public repo. Do not develop in the public repo; treat it as a published artefact.

## Worth doing, not done here

- **Publish the OpenAPI contract at a public URL** (e.g. `docs.beel.es/public-api.yaml`).
  Today `spec:verify` can only prove the vendored copy has not been hand-edited; with a
  public source, the public CI could verify it has not drifted from production either.
  It is also a genuine developer-experience and discoverability win on its own.
- **Automate the tool catalogue.** `npm run tools:catalog` generates the MDX behind
  `docs.beel.es/mcp/tools`, but publishing it is manual, so it drifts. It should be a CI
  step on release.
- **Reconsider 119 tools.** That is a lot of context for an agent to carry. The policy
  layer already makes this a data-driven decision — a `preset` (core / full) would let
  clients ask for the 20 tools that matter.
