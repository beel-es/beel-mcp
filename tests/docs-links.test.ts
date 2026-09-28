import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSnapshot, SNAPSHOT_PATH, sitemapPaths } from '../scripts/sync-docs-index.mjs';
import { ERROR_CATALOG, docsUrlForCode } from '../src/guardrails/catalog.js';
import { GUARDRAILS } from '../src/guardrails/rules.js';
import { guardrailUri } from '../src/guardrails/rules.js';
import { readGuardrailResource } from '../src/resources/guardrails.js';
import { INTEGRATION_GUIDE_PATH } from '../src/server.js';
import { BEEL_DEFAULTS } from '../src/shared/defaults.js';

/**
 * Every docs link this server writes for an agent resolves to a page the docs
 * site publishes. A link that 404s sends the agent on a call that answers
 * nothing, and nothing else in the build notices: these are strings.
 *
 * Checked offline, against `tests/fixtures/docs-paths.json`, the page list of the
 * docs sitemap written by `npm run sync:docs-index`. Machine endpoints under
 * `/api/` and `/llms.txt` are not pages and are not listed there.
 */

const published = new Set<string>(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as string[]);

/** The page a docs URL or path points at: no host, anchor, query, `.md` twin or `/llms.mdx` prefix. */
function pagePath(link: string): string {
  const path = new URL(link, BEEL_DEFAULTS.docsUrl).pathname
    .replace(/^\/llms\.mdx(?=\/|$)/, '')
    .replace(/\.md$/, '')
    .replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

const isMachineEndpoint = (path: string): boolean =>
  path.startsWith('/api/') || path === '/llms.txt';

/** Every file under src/ an agent can end up reading, except the catalogue snapshots. */
function agentFacingFiles(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return agentFacingFiles(path);
    return /\.(ts|md)$/.test(entry) ? [path] : [];
  });
}

describe('the docs index snapshot', () => {
  it('is exactly what `npm run sync:docs-index` writes — never edited by hand', () => {
    const text = readFileSync(SNAPSHOT_PATH, 'utf8');
    expect(text).toBe(formatSnapshot(JSON.parse(text) as string[]));
    expect(published.size).toBeGreaterThan(100);
  });

  it('reads page paths out of a sitemap', () => {
    const xml =
      '<urlset><url><loc>https://docs.beel.es/guides/idempotency/</loc></url>' +
      '<url><loc>https://docs.beel.es/</loc></url></urlset>';
    expect(sitemapPaths(xml)).toEqual(['/guides/idempotency', '/']);
  });
});

describe('every docs link an agent reads resolves to a published page', () => {
  it('each guide names a published page, rendered as an absolute URL', async () => {
    for (const guide of GUARDRAILS) {
      expect(published.has(guide.docPath), `${guide.id}: ${guide.docPath}`).toBe(true);
      const body = (await readGuardrailResource(guardrailUri(guide.id)))!;
      expect(body).toContain(`Canonical documentation: ${BEEL_DEFAULTS.docsUrl}${guide.docPath}`);
    }
  });

  it('each error code the catalogue explains has its page, unless it says it has none', () => {
    const missing = Object.keys(ERROR_CATALOG).filter((code) => {
      const url = docsUrlForCode(code);
      return url !== undefined && !published.has(pagePath(url));
    });
    expect(missing).toEqual([]);
  });

  it('a code marked without a page really has none, so the mark goes when one appears', () => {
    const marked = Object.entries(ERROR_CATALOG).filter(([, entry]) => entry.page === false);
    expect(marked.length).toBeGreaterThan(0);
    for (const [code] of marked) {
      expect(docsUrlForCode(code)).toBeUndefined();
      expect(published.has(`/errors/${code}`), code).toBe(false);
    }
  });

  it('the integration guide the instructions name is published', () => {
    expect(published.has(INTEGRATION_GUIDE_PATH)).toBe(true);
  });

  it('every literal docs.beel.es link under src/ is published', () => {
    const broken: string[] = [];
    for (const file of agentFacingFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/https:\/\/docs\.beel\.es(\/[^\s'"`)<>\]]*)?/g)) {
        const link = match[0].replace(/[.,;:]+$/, '');
        // A template (`/errors/<CODE>`, `${…}`) is checked through the values it takes.
        if (/[<{$]/.test(text.slice(match.index, match.index + match[0].length + 1))) continue;
        const path = pagePath(link);
        if (isMachineEndpoint(path) || published.has(path)) continue;
        broken.push(`${file}: ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
