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

  it('reads the packed file list from either npm output shape', async () => {
    // npm 12 changed `npm pack --json` from a one-element array to an object
    // keyed by package name. Read blindly, the packaging check reports that
    // nothing at all would be published — alarming, and completely wrong.
    const { readPackedEntry } = await import('../scripts/verify-package.mjs');
    const entry = { files: [{ path: 'dist/index.js' }], size: 1234 };

    expect(readPackedEntry([entry])).toEqual(entry);
    expect(readPackedEntry({ '@beel_es/mcp': entry })).toEqual(entry);
  });

  it('refuses to interpret an output shape it does not recognise', async () => {
    // Failing loudly beats reporting an empty package as if it were the truth.
    const { readPackedEntry } = await import('../scripts/verify-package.mjs');
    expect(() => readPackedEntry({})).toThrow();
    expect(() => readPackedEntry({ pkg: { files: 'not an array' } })).toThrow();
  });

  it('names what is missing, and what should not be there', async () => {
    const { findProblems } = await import('../scripts/verify-package.mjs');
    const manifest = { bin: { 'beel-mcp': 'dist/index.js' } };

    const complete = findProblems(manifest, new Set([
      'dist/index.js', 'dist/mcpapp/invoice-pdf.html',
      'openapi/public-api.yaml', 'LICENSE', 'README.md',
    ]));
    expect(complete).toEqual([]);

    const missing = findProblems(manifest, new Set(['dist/index.js']));
    expect(missing.join(' ')).toMatch(/invoice-pdf\.html would not be published/);

    const leaking = findProblems(manifest, new Set([
      ...['dist/index.js', 'dist/mcpapp/invoice-pdf.html', 'openapi/public-api.yaml', 'LICENSE', 'README.md'],
      'src/index.ts',
    ]));
    expect(leaking.join(' ')).toMatch(/src\/index\.ts would be published/);
  });
});
