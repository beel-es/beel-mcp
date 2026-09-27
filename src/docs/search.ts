/**
 * The documentation, through the docs site's own endpoints:
 *
 *   GET /api/search?q=…&limit=…[&area=…]   the matching pages, ranked by the site
 *   GET /llms.mdx/<path>                    one page, as Markdown
 *   GET /llms.txt                           the index of every page
 *
 * Ranking lives on the docs site, shared with its search box and the CLI; this
 * module only builds the requests and renders the answers for the model.
 */

import { fetchDocs } from './fetch.js';

export interface SearchResult {
  title: string;
  section: string | null;
  url: string;
  md_url: string;
  snippet: string;
  score: number;
  deprecated?: boolean;
}

export interface SearchResponse {
  query: string;
  area: string | null;
  total: number;
  offset: number;
  limit: number;
  results: SearchResult[];
}

export interface SearchOptions {
  limit: number;
  area?: string;
}

/** Search the documentation. A malformed answer fails loudly rather than reading as "nothing found". */
export async function searchDocs(query: string, options: SearchOptions): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(options.limit) });
  if (options.area) params.set('area', options.area);
  const body = JSON.parse(await fetchDocs(`/api/search?${params}`)) as SearchResponse;
  if (!Array.isArray(body.results)) throw new Error('The docs search answered without results.');
  return body;
}

/** Render search results for the model: where to read, and why each one matched. */
export function renderSearch(response: SearchResponse): string {
  if (response.results.length === 0) {
    return `No documentation matches "${response.query}". Try other words, or beel_docs_list to browse.`;
  }
  const lines = [
    `${response.total} pages match "${response.query}"; the first ${response.results.length}:`,
    '',
  ];
  response.results.forEach((r, i) => {
    const where = r.section ? `${r.title} › ${r.section}` : r.title;
    lines.push(`${i + 1}. ${where}${r.deprecated ? ' (deprecated)' : ''}`);
    lines.push(`   url: ${r.url}`);
    lines.push(`   read: beel_docs_get with "${r.md_url}"`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join('\n');
}

/**
 * The Markdown path of a page, from what an agent has in hand: a result's
 * `md_url` or `url` (absolute or a path, with or without an anchor), or a path
 * such as `/guides/idempotency`. `null` when the input is not a path at all —
 * then it is a title, and the caller searches for it.
 */
export function markdownPath(page: string): string | null {
  const trimmed = page.trim();
  let path: string;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  } else if (trimmed.startsWith('/')) {
    path = trimmed.split(/[?#]/)[0]!;
  } else {
    return null;
  }
  path = path.replace(/\/+$/, '') || '/';
  if (path.startsWith('/llms.mdx') || path.endsWith('.md')) return path;
  return path === '/' ? '/llms.mdx' : `/llms.mdx${path}`;
}

/**
 * Ceiling on a rendered page. Pages are a few KB; the longest reference pages
 * run to tens. Truncation is announced so the agent searches for the part it
 * needs rather than assuming it read everything.
 */
export const MAX_PAGE_CHARS = 30_000;

/** Read one page as Markdown: by path or URL, or by title via the search's first hit. */
export async function readPage(page: string): Promise<string> {
  let path = markdownPath(page);
  if (path === null) {
    const { results } = await searchDocs(page, { limit: 1 });
    if (results.length === 0) return `No documentation page matches "${page}".`;
    path = markdownPath(results[0]!.md_url)!;
  }
  const text = await fetchDocs(path);
  if (text.length <= MAX_PAGE_CHARS) return text;
  return (
    `${text.slice(0, MAX_PAGE_CHARS)}\n\n[…truncated: the page is ${text.length} characters. ` +
    'Search with more specific terms to reach the part you need.]'
  );
}

/** Parse the llms.txt index into a flat list of `{ title, url }` link entries. */
export function parseIndex(index: string): Array<{ title: string; url: string }> {
  const entries: Array<{ title: string; url: string }> = [];
  for (const line of index.split('\n')) {
    const match = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)/);
    if (match) entries.push({ title: match[1]!.trim(), url: match[2]!.trim() });
  }
  return entries;
}
