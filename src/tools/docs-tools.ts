import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { fetchDocsFile } from '../docs/fetch.js';
import {
  findPage,
  parseIndex,
  renderChunks,
  searchChunks,
  splitChunks,
} from '../docs/search.js';

/**
 * Documentation tools. The BeeL docs (VeriFactu rules, fiscal scenarios, worked
 * payload examples) are the canonical source of the guardrails — an agent should
 * search them before composing a non-trivial invoice. These hit static text
 * files and spend no API quota.
 */

export const DOCS_SEARCH = 'beel_docs_search';
export const DOCS_GET = 'beel_docs_get';
export const DOCS_LIST = 'beel_docs_list';

export const docsTools: Tool[] = [
  {
    name: DOCS_SEARCH,
    description:
      'Search the BeeL API documentation (VeriFactu, invoice types, taxes, regime keys, ' +
      'corrective invoices, international customers, worked examples). Returns the most ' +
      'relevant sections. Use this before building non-trivial invoices or when unsure ' +
      'about a fiscal rule.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Search keywords, e.g. ["recargo", "equivalencia"] or ["corrective", "R5"].',
          minItems: 1,
        },
        limit: { type: 'integer', description: 'Max sections to return (default 3).', default: 3 },
      },
      required: ['terms'],
    },
    annotations: { title: 'Search docs', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: DOCS_GET,
    description:
      'Fetch a full documentation page by title (all its sections), e.g. "Invoice types" ' +
      'or "Regime keys". Use after beel_docs_list or beel_docs_search to read a page in full.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page title or a distinctive part of it.' },
      },
      required: ['page'],
    },
    annotations: { title: 'Get docs page', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: DOCS_LIST,
    description: 'List the available BeeL documentation pages (titles and URLs).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List docs pages', readOnlyHint: true, openWorldHint: true },
  },
];

export async function executeDocsTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case DOCS_SEARCH: {
      const terms = (args.terms as string[] | undefined) ?? [];
      const limit = typeof args.limit === 'number' ? args.limit : 3;
      const full = await fetchDocsFile('llms-full.txt');
      return renderChunks(searchChunks(splitChunks(full), terms, limit));
    }
    case DOCS_GET: {
      const page = String(args.page ?? '');
      const full = await fetchDocsFile('llms-full.txt');
      return renderChunks(findPage(splitChunks(full), page));
    }
    case DOCS_LIST: {
      const index = await fetchDocsFile('llms.txt');
      const entries = parseIndex(index);
      return entries.map((e) => `- ${e.title} — ${e.url}`).join('\n') || 'No pages found.';
    }
    default:
      throw new Error(`Unknown docs tool: ${name}`);
  }
}

export function isDocsTool(name: string): boolean {
  return name === DOCS_SEARCH || name === DOCS_GET || name === DOCS_LIST;
}
