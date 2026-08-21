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

export default defineConfig({
  plugins: [textModules()],
});
