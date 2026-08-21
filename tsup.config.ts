import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  minify: false,
  sourcemap: false,
  // Some bundled deps reference CJS builtins via require(); shim it for the ESM output.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // The OpenAPI spec travels as a string inside the bundle; the SDK and yaml are
  // bundled in too. Result: an npm package with no runtime install step — `npx` boots instantly.
  noExternal: [/.*/],
  loader: {
    '.yaml': 'text',
    '.md': 'text',
  },
});
