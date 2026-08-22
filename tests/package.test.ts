import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * What ships in the npm tarball is decided by `files` in package.json and by the
 * order the build steps run in — neither of which any other test exercises. A
 * missing artefact here is invisible until someone runs the published binary.
 */
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  bin?: Record<string, string>;
  files?: string[];
  scripts: Record<string, string>;
  publishConfig?: Record<string, unknown>;
};

describe('the published package', () => {
  it('declares a binary that the build actually produces', () => {
    expect(pkg.bin).toBeDefined();
    for (const target of Object.values(pkg.bin!)) {
      const path = target.replace(/^\.\//, '');
      expect(existsSync(path), `${path} is missing — run npm run build`).toBe(true);
      expect(readFileSync(path, 'utf8').startsWith('#!'), `${path} has no shebang, so npx cannot run it`).toBe(true);
    }
  });

  it('builds the MCP App viewer after the bundler, not before', () => {
    // tsup runs with `clean: true`, so it wipes dist/. Generating the viewer
    // first means the bundler deletes it, and only the npm package notices:
    // the Worker embeds the same file as a text module at bundle time.
    const build = pkg.scripts.build!;
    expect(build.indexOf('tsup')).toBeLessThan(build.indexOf('build-mcpapp'));
  });

  it('ships the viewer the stdio server reads from disk', () => {
    expect(existsSync('dist/mcpapp/invoice-pdf.html')).toBe(true);
  });

  it('ships the contract, which the tool surface is derived from at runtime', () => {
    expect(pkg.files).toContain('openapi');
    expect(existsSync('openapi/public-api.yaml')).toBe(true);
  });

  it('ships nothing beyond what the runtime needs', () => {
    // Sources, tests and workflows have no business in a consumer's node_modules.
    expect(pkg.files).toEqual(['dist', 'openapi', 'LICENSE', 'README.md']);
  });

  it('publishes publicly with provenance', () => {
    expect(pkg.publishConfig).toMatchObject({ access: 'public', provenance: true });
  });
});
