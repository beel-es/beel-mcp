# Deploying the remote MCP server

The remote server (`https://mcp.beel.es`) runs on **Cloudflare Workers**. It speaks the
Streamable HTTP transport and is a full OAuth **authorization server** towards MCP clients
while acting as a plain OAuth **client** towards BeeL. Each user logs in with their own
BeeL account; their token lives in the encrypted grant and is forwarded to the API on
every call, so the server is multi-tenant and holds no long-lived credential of its own.

Authorization is handled by
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider):
Dynamic Client Registration, `/authorize`, `/token` and KV-backed grants are its job, not
ours. Our code is two Hono routes — `/authorize` (redirect upstream with PKCE) and
`/callback` (exchange the code, complete the authorization). Resist the temptation to
hand-roll this part; a previous iteration did, and spent eight commits on it.

## 1. Prerequisites

- A Cloudflare account with Workers (Durable Objects require a paid plan).
- An OAuth client registered at BeeL — see step 3. This is the real gate: without it
  the deployment is complete and still cannot authenticate anyone.

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Put the id it prints into `kv_namespaces[0].id`, and set `routes` to your own hostname.

`wrangler.jsonc` holds the deployment's non-secret configuration — the namespace id, the
route, and the public `vars`. None of it is a credential: a KV namespace id is useless
without a Cloudflare API token. Real secrets never go in this file; they are set with
`wrangler secret put` and live only in Cloudflare.

## 3. Register the OAuth client at BeeL

The MCP server drives the upstream flow as a pre-registered client, `beel-mcp` by default.
It must:

- be **public** (`client-authentication-methods: none`) so PKCE (S256) is the protection.
  A confidential client also works — set `BEEL_OAUTH_CLIENT_SECRET` and the server
  switches to `client_secret_basic` — but public gives the cleanest UX: the user pastes a
  URL and logs in, with no client id or secret to enter anywhere.
- allow the worker's own callback, `https://<your-host>/callback`, as a redirect URI. This
  is the redirect **the worker** sends to BeeL, not the MCP client's callback.
- grant the scopes the tools need. The consent screen requests the intersection of what
  the tools require (derived from the contract) with what the backend advertises in
  `/.well-known/oauth-authorization-server`, so a scope no tool uses is never requested.

## 4. Configure

Public values go in `vars` in `wrangler.jsonc`; everything else goes through
`wrangler secret put` and never appears in the repository:

```bash
npx wrangler secret put BEEL_PDF_STORAGE_HOSTS   # comma-separated storage hosts
npx wrangler secret put MCP_IDENTITY_HMAC_KEY    # dedicated HMAC key
npx wrangler secret put BEEL_OAUTH_CLIENT_SECRET # only for a confidential client
```

The KV namespace id and the route stay in `wrangler.jsonc`. Neither is a
credential — a namespace id is useless without an API token, and the hostname is
a public endpoint — and keeping them versioned is what makes the deployment
reproducible from a clone.

| Variable | Required | Notes |
|---|---|---|
| `BEEL_OAUTH_ISSUER` | yes | Must equal the `iss` in BeeL's tokens. `authorize`/`token`/`revoke` derive from it as `<issuer>/oauth2/*`. |
| `BEEL_BASE_URL` | yes | API base the user's token is forwarded to. |
| `BEEL_OAUTH_CLIENT_ID` | no | Defaults to `beel-mcp`. |
| `BEEL_DOCS_URL` | no | Documentation source for the docs tools. |
| `BEEL_PDF_STORAGE_HOSTS` | secret | Comma-separated storage hosts the invoice-PDF relay may fetch from. **Unset disables the relay**, so the viewer cannot paint the invoice. A secret rather than a var: these are internal hostnames, and publishing them only invites probing. |
| `MCP_VERIFIED_CLIENTS` | no | JSON array of `{prefix,name}` extending the built-in list of well-known MCP callbacks. Can only extend it: every entry is re-validated as a non-loopback `https` callback. |
| `BEEL_OAUTH_CLIENT_SECRET` | secret | Only for a confidential client. |
| `BACKEND_REPOSITORY` | GitHub var | Only for `sync-spec.yml`: `owner/name` of the private backend repository the contract is bundled from. |

Secrets set with `wrangler secret put` survive redeploys, so Workers Builds does not
need them in its own build settings.
| `MCP_IDENTITY_HMAC_KEY` | secret | Dedicated key for the client-identity assertion (see below). Falls back to the client secret if unset; give it its own key so the two rotate independently. |

Individual OAuth endpoints can be overridden with `BEEL_OAUTH_AUTHORIZE_URL`,
`BEEL_OAUTH_TOKEN_URL` and `BEEL_OAUTH_REVOKE_URL` when they do not follow the
`<issuer>/oauth2/*` pattern.

> **Get the issuer exactly right.** A mismatched issuer makes every token fail validation
> with a 401 and nothing else explains why. Take it verbatim from
> `GET <api-base>/.well-known/oauth-authorization-server`.

## 5. Deploy

Deployment runs through **Cloudflare Workers Builds**, connected to this repository:
every push to the production branch builds and deploys, with no pipeline to maintain.

### Required build configuration

In **Settings → Build → Branch control**, keep **"Builds for non-production branches"
disabled**, so that only the production branch builds.

This is a security requirement rather than a preference: build environments hold
deployment credentials, and they should only ever be reachable from a branch that
requires write access to push to. Re-check it after any reconfiguration of the
connection — nothing in this repository can enforce a setting that lives elsewhere.

### Deploying by hand

```bash
npx wrangler deploy --dry-run --outdir /tmp/worker-build   # bundles, no credentials
npx wrangler deploy                                        # uses your wrangler login
```

Then point an MCP client at `https://<your-host>/mcp` and log in — that is the endpoint,
not the root, which serves nothing. `GET /healthz` answers without auth and is what a
health check should target.

## How a connection is established

1. The client hits `/mcp` with no token and gets a `401` carrying
   `WWW-Authenticate: …resource_metadata=…/.well-known/oauth-protected-resource`.
2. It reads the metadata and self-registers through `/register` (DCR, handled by
   workers-oauth-provider).
3. `/authorize` stores the parsed request plus a fresh PKCE verifier in KV under a
   single-use state token, then redirects to BeeL's login.
4. `/callback` exchanges the code for BeeL's tokens and calls `completeAuthorization`,
   which stores them encrypted in the grant.
5. Each tool call surfaces that token as the bearer for the API. When the client refreshes
   its token, `tokenExchangeCallback` refreshes the upstream one too — the worker's token
   is deliberately given a shorter TTL so it always expires first.

### Client identity on the consent screen

The consent screen shows which client is asking. DCR client names are self-asserted —
anyone can register as "Claude" — so the only provable signal is the registered
`redirect_uri` host. A callback matching a curated allowlist of well-known MCP hosts earns
a verified badge; everything else renders as unverified with its origin shown. Loopback
callbacks and custom schemes never qualify, since any local application can claim them.

That identity travels to the backend as an HS256 assertion signed with
`MCP_IDENTITY_HMAC_KEY`, bound to the specific `client_id` and `redirect_uri` and carrying
a single-use `jti`, so a "verified" assertion cannot be transplanted onto another request
or replayed.

## Operating notes

- **Logs** carry one structured line per tool call — tool name, outcome, upstream status
  and latency. No arguments, tokens or personal data, by design.
- **The final hop to the client's callback is served as an interstitial page**, not a
  302. The consent POST originates on BeeL's domain and its CSP `form-action` governs the
  whole redirect chain, which would block any host outside it. Ending the chain on our own
  domain and jumping with `location.replace` sidesteps that without weakening anyone's CSP.
