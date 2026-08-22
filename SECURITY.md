# Security policy

## Reporting a vulnerability

Email **security@beel.es** with the details. Please do not open a public issue for
a vulnerability. We aim to acknowledge within two business days.

If the issue affects invoice data, VeriFactu submissions or AEAT reporting, say so
in the subject line — those are escalated immediately.

## Scope

In scope: this MCP server, the remote deployment at `mcp.beel.es`, and the OAuth flow
between them and the BeeL API.

Out of scope here: the BeeL API and web application — report those to the same
address and they will be routed — and findings that require already holding a
valid BeeL credential for the affected account.

## Design decisions worth knowing before you report

These are intentional, and stating them saves everyone a round trip:

- **The BeeL API is the authority on every fiscal invariant.** The checks in
  `src/guardrails/validate.ts` are a pre-flight that mirrors a strict subset of
  the API's own rejections, so they can only fail a request earlier and more
  clearly. They are not an access-control layer and nothing depends on them
  being exhaustive.
- **The invoice-PDF relay grants no new access.** The presigned URL is itself the
  capability; the relay only re-serves those bytes inline for a sandboxed viewer,
  and only for an explicitly configured allowlist of storage hosts. It fails
  closed when unconfigured.
- **Tool annotations are advisory.** `destructiveHint` and friends are hints MCP
  clients use to decide whether to confirm an action. They are not enforcement.

## Handling credentials

The server never persists an API key or access token. In stdio mode the key comes
from the environment; in remote mode the caller's BeeL token lives in the OAuth
grant and is forwarded per request. Tool-call logs deliberately carry no
arguments, tokens or personal data — only the tool name, outcome, upstream status
and latency.
