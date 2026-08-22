import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * What ships to npm is decided by `package.json` — the `files` list, the `bin`
 * entry, and the order the build steps run in. This asserts those decisions.
 *
 * Whether the build actually produced them is a different question, and one this
 * suite cannot answer: tests run before the build in CI. `npm run verify:package`
 * checks the built output and the packed tarball, and runs in both pipelines.
 */
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  bin?: Record<string, string>;
  files?: string[];
  scripts: Record<string, string>;
  publishConfig?: Record<string, unknown>;
};

describe('what the published package declares', () => {
  it('exposes the stdio server as its binary', () => {
    // Path without a leading "./": npm rewrites it on publish otherwise, and
    // warns about a package.json it had to correct.
    expect(pkg.bin).toEqual({ 'beel-mcp': 'dist/index.js' });
  });

  it('builds the MCP App viewer after the bundler, not before', () => {
    // tsup runs with `clean: true`, so it wipes dist/. Generating the viewer
    // first means the bundler deletes it, and only the npm package notices:
    // the Worker embeds the same file as a text module at bundle time.
    const build = pkg.scripts.build!;
    expect(build.indexOf('tsup')).toBeLessThan(build.indexOf('build-mcpapp'));
  });

  it('ships the runtime and nothing else', () => {
    // The contract is read at runtime to derive the tool surface, so it travels
    // with the package. Sources, tests and workflows do not.
    expect(pkg.files).toEqual(['dist', 'openapi', 'LICENSE', 'README.md']);
  });

  it('publishes publicly, and does not demand provenance in the manifest', () => {
    // Trusted publishing attaches provenance on its own. Asking for it here
    // instead makes every publish outside CI fail with "provider: null" — which
    // includes the first one, and that one can only be manual.
    expect(pkg.publishConfig).toEqual({ access: 'public' });
  });

  it('keeps a packaging check that runs after the build', () => {
    expect(pkg.scripts['verify:package']).toBeDefined();
  });
});
