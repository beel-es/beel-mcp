import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // Wipes dist/ before writing. The MCP App viewer is generated into dist/mcpapp
  // by scripts/build-mcpapp.mjs, so that step runs AFTER this one — the reverse
  // order silently deletes the viewer, and only the npm package notices (the
  // Worker embeds it as a text module at bundle time instead of reading it).
  clean: true,
  minify: false,
  sourcemap: false,
  // Some bundled deps reference CJS builtins via require(); shim it for the ESM output.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // Everything is bundled, with no exception. This is what lets package.json
  // declare no runtime dependencies at all: `npx @beel_es/mcp` installs the
  // tarball and nothing else, so a consumer's boot time does not depend on the
  // dependency tree. Moving anything back to `dependencies` requires taking it
  // out of here first, or consumers install a package they never load.
  noExternal: [/.*/],
  // Guardrail prose is imported as a text module. The OpenAPI document is not:
  // the Node build reads openapi/public-api.yaml from disk at startup (see
  // src/spec/load.ts), which is why `openapi/` ships in `files`. Only the Worker,
  // which has no filesystem, embeds it as a text module.
  loader: {
    '.yaml': 'text',
    '.md': 'text',
  },
});
