import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Guardrail prose is imported as a text module (`import body from './x.md'`),
 * which tsup and wrangler each provide through their own loader. Vite has no
 * equivalent built in, so tests get the same contract from this plugin —
 * otherwise they would exercise a different module shape than production.
 */
function textModules(): Plugin {
  return {
    name: 'beel-text-modules',
    transform(_code, id) {
      if (!id.endsWith('.md')) return null;
      const text = readFileSync(id.split('?')[0]!, 'utf8');
      return { code: `export default ${JSON.stringify(text)};`, map: null };
    },
  };
}

/**
 * Binary assets the Worker embeds with wrangler's `Data` rule, which hands the
 * module an ArrayBuffer. Tests get the same shape from the file's bytes.
 */
function binaryModules(): Plugin {
  return {
    name: 'beel-binary-modules',
    transform(_code, id) {
      if (!id.endsWith('.woff2')) return null;
      const base64 = readFileSync(id.split('?')[0]!).toString('base64');
      const code = `const b = Buffer.from(${JSON.stringify(base64)}, 'base64');
export default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);`;
      return { code, map: null };
    },
  };
}

export default defineConfig({
  plugins: [textModules(), binaryModules()],
});
