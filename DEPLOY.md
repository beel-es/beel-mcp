# Deploying the BeeL MCP server (remote / OAuth)

This deploys the **remote** server (`beel-mcp-http`) at e.g. `https://mcp.beel.es`. It
speaks Streamable HTTP and acts as an OAuth 2.1 **Resource Server** in front of BeeL's
authorization server: each user logs in with their own BeeL account and the server
forwards their token to the API (multi-tenant). It validates JWTs offline via BeeL's
JWKS, so **it needs no secrets at runtime**.

> Recommended host: a long-running container (Dokploy, Fly, Render, a VM). **Not Vercel**
> — the server keeps in-memory sessions and streams, which serverless functions don't fit.

## 1. Runtime environment variables

| Var | Required | Value (prod example) | Notes |
|---|---|---|---|
| `PORT` | no | `8787` | Port the server listens on. |
| `MCP_PUBLIC_URL` | **yes** | `https://mcp.beel.es` | Public URL; goes into the advertised OAuth metadata. Must match the real external URL. |
| `BEEL_OAUTH_ISSUER` | **yes** | `https://app.beel.es` *(confirm — see ⚠️)* | Must equal the `iss` claim in BeeL's tokens. authorize/token/jwks/revoke derive from it as `<issuer>/oauth2/*`. |
| `BEEL_BASE_URL` | **yes** | `https://app.beel.es/api` | API base the user token is forwarded to. |
| `BEEL_PDF_DOMAINS` | no | `https://minio.beel.es,https://app.beel.es` | CSP `frame-src` allowlist for the PDF viewer panel. Set to wherever presigned invoice PDFs are served. |
| `BEEL_DOCS_URL` | no | `https://docs.beel.es` | Docs source for the search tools (default already correct). |

You can override individual OAuth endpoints if they don't follow the `<issuer>/oauth2/*`
pattern: `BEEL_OAUTH_JWKS_URL`, `BEEL_OAUTH_AUTHORIZE_URL`, `BEEL_OAUTH_TOKEN_URL`,
`BEEL_OAUTH_REVOKE_URL`.

> ⚠️ **Confirm the issuer.** Locally the issuer is `http://localhost:8080/api` (endpoints
> under `/api/oauth2/*`); the public docs show `https://app.beel.es/oauth2/*` (no `/api`).
> Set `BEEL_OAUTH_ISSUER` (and, if needed, `BEEL_OAUTH_JWKS_URL`) to **exactly** what the
> production discovery doc reports: `GET https://app.beel.es/.well-known/oauth-authorization-server`.
> A mismatched issuer makes every token fail validation (401).

## 2. Backend prerequisite — the OAuth client (the real gate)

The MCP connector flow in Claude/ChatGPT needs an OAuth client it can use. BeeL already
defines a `beel-mcp` client (`backend/src/main/resources/application.yml`), confidential
(`client_secret_basic`) + PKCE. Two things must be true in production:

1. `OAUTH2_CLIENT_SECRET` is set in the backend env (the client secret).
2. The MCP client's **redirect URI is allowed**. Today the client allows
   `http://localhost:3000/oauth/callback` and `http://localhost:8000/auth/callback`. Add
   the redirect URI(s) your MCP host uses via `OAUTH2_REDIRECT_URIS` — **or** enable
   **Dynamic Client Registration (DCR)** on the Spring Authorization Server so hosts that
   require "click & connect" (Claude.ai, ChatGPT) can self-register. Without DCR or a
   matching redirect, the interactive connector won't complete.

The MCP server itself needs no client secret — it only validates tokens.

## 3. Dokploy

1. **New Application** → source = GitHub `beel-es/beel-mcp`, branch `master`, build type
   **Dockerfile** (the repo's `Dockerfile`).
2. **Environment** → set the variables from §1.
3. **Domains** → add `mcp.beel.es`, container port `8787`, enable HTTPS (Let's Encrypt).
4. **Deploy.** Health is checked at `/healthz` (the image has a `HEALTHCHECK`).

(Equivalent anywhere else: `docker build -t beel-mcp . && docker run -p 8787:8787 -e MCP_PUBLIC_URL=... beel-mcp`.)

## 4. DNS / TLS

Point `mcp.beel.es` at the Dokploy host; Dokploy/Traefik issues the TLS cert. The public
URL must be HTTPS — MCP clients refuse plain HTTP.

## 5. Connect it in Claude

Claude.ai (Pro/Max/Team/Enterprise) or Claude Desktop → **Settings → Connectors → Add
custom connector** → URL `https://mcp.beel.es/mcp`. Claude discovers the OAuth config,
you log in to BeeL, consent the scopes, and the tools appear — including the PDF viewer
that renders emitted invoices in a side panel.

## 6. Verify the deployment

```bash
curl https://mcp.beel.es/healthz
# {"status":"ok","name":"beel-mcp","version":"..."}

curl https://mcp.beel.es/.well-known/oauth-protected-resource/mcp
# { "resource": "...", "authorization_servers": ["https://app.beel.es"], "scopes_supported": [...] }

curl -i -X POST https://mcp.beel.es/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# 401 + WWW-Authenticate: Bearer ... resource_metadata="https://mcp.beel.es/.well-known/oauth-protected-resource/mcp"
```

## Operational notes

- **Sessions are in memory** → run a single instance, or put sticky routing on the
  `mcp-session-id` header behind a load balancer (or add a shared session store).
- **Tokens** last ~1h; the session binds the token at `initialize`. Long sessions across a
  token refresh would need re-connect (acceptable for v1).
- **Spec sync**: the OpenAPI surface is regenerated by `.github/workflows/sync-spec.yml`;
  redeploy after a spec bump to pick up new tools.

## Local quick test (no deploy, no OAuth)

To try the tools and the PDF panel fast, run the **stdio** server in Claude Desktop with an
API key — see the README's "Install & configure".
