import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import { GUARDRAILS, GUARDRAIL_URI_PREFIX, findGuardrail, guardrailUri } from '../guardrails/domain.js';

/**
 * Expose each domain guardrail as an MCP resource so clients can pin or preload
 * the fiscal rules. An overview resource lists them all.
 */

const OVERVIEW_URI = 'beel://guardrails';

export const guardrailResources: Resource[] = [
  {
    uri: OVERVIEW_URI,
    name: 'BeeL fiscal guardrails (overview)',
    description:
      'Index of the Spanish-invoicing fiscal guardrails that govern the BeeL API: ' +
      'invoice state machine, void vs rectify, invoice types F1/F2/R1–R5, regime keys, ' +
      'NIF validation, VeriFactu gates, multi-NIF accounts.',
    mimeType: 'text/markdown',
  },
  ...GUARDRAILS.map(
    (g): Resource => ({
      uri: guardrailUri(g.id),
      name: g.title,
      description: `Guardrail: ${g.title}. Canonical docs: ${g.docPath}`,
      mimeType: 'text/markdown',
    }),
  ),
];

function overviewBody(): string {
  const items = GUARDRAILS.map((g) => `- **${g.title}** — \`${guardrailUri(g.id)}\` (docs: ${g.docPath})`);
  return [
    '# BeeL fiscal guardrails',
    '',
    'These invariants must be respected when driving the BeeL API. Read the relevant',
    'guardrail resource before mutating fiscal data, and call `beel_docs_search` for the',
    'exhaustive rules and worked examples.',
    '',
    ...items,
  ].join('\n');
}

/** Resolve a guardrail resource URI to its markdown content; null if unknown. */
export function readGuardrailResource(uri: string): string | null {
  if (uri === OVERVIEW_URI) return overviewBody();
  if (!uri.startsWith(GUARDRAIL_URI_PREFIX)) return null;
  const id = uri.slice(GUARDRAIL_URI_PREFIX.length);
  const doc = findGuardrail(id);
  if (!doc) return null;
  return `# ${doc.title}\n\n${doc.body}\n\nCanonical docs: ${doc.docPath}`;
}
