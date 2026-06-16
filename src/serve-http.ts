#!/usr/bin/env node
import { createHttpApp } from './http/serve.js';
import { loadOAuthConfig } from './http/oauth.js';

// `require` is injected by the tsup banner (createRequire); resolves the published package.json.
const { version } = require('../package.json') as { version: string };

const port = Number(process.env.PORT ?? 3000);
const config = loadOAuthConfig();
const app = createHttpApp({ name: 'beel-mcp', version }, config);

app.listen(port, () => {
  process.stderr.write(
    `[beel-mcp-http] listening on :${port}\n` +
      `  resource:  ${config.resourceServerUrl}/mcp\n` +
      `  issuer:    ${config.issuer}\n` +
      `  jwks:      ${config.jwksUri}\n` +
      `  metadata:  ${config.resourceServerUrl}/.well-known/oauth-protected-resource/mcp\n`,
  );
});
