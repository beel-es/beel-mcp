# Security policy

## Reporting a vulnerability

Email **security@beel.es** with the details. Please do not open a public issue for
a vulnerability. We aim to acknowledge within two business days.

If the issue affects invoice data, VeriFactu submissions or AEAT reporting, say so
in the subject line — those are escalated immediately.

## Scope

In scope: this MCP server, the remote deployment at `mcp.beel.es`, and the OAuth flow
between them and the BeeL API.

Out of scope: the BeeL API and web application (report those the same way, they
are simply handled by a different team), and findings that require an attacker to
already hold a valid BeeL API key or access token for the affected account.

## What this server is, security-wise

Some deliberate design decisions are easy to mistake for bugs:

- **The guardrails are not an authorization boundary.** Fiscal invariants are
  enforced by the BeeL API. The checks in `src/guardrails/validate.ts` are a
  pre-flight that mirrors a strict subset of the API's own rejections; they exist
  to fail faster with a better message, never to grant or withhold access.
- **The invoice-PDF relay grants no new access.** The presigned URL is itself the
  capability; the relay only re-serves those bytes inline for a sandboxed viewer,
  and only for hosts explicitly listed in `BEEL_PDF_STORAGE_HOSTS`. With that
  variable unset the relay is disabled.
- **Tool annotations are advisory.** `destructiveHint` and friends are hints MCP
  clients use to decide whether to confirm an action. They are not enforcement.

## Handling credentials

The server never persists an API key or access token. In stdio mode the key comes
from the environment; in remote mode the caller's BeeL token lives in the OAuth
grant and is forwarded per request. Tool-call logs deliberately carry no
arguments, tokens or personal data — only the tool name, outcome, upstream status
and latency.
