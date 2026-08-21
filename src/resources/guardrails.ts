import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import {
  GUARDRAILS,
  GUARDRAIL_URI_PREFIX,
  findGuardrail,
  guardrailUri,
} from '../guardrails/rules.js';
import { ERROR_CATALOG, catalogCodes } from '../guardrails/catalog.js';

/**
 * The fiscal guardrails as MCP resources, so a client can pin or preload them
 * and a model can read the full rule instead of the one-line hint that fits in
 * a tool description.
 *
 * Three kinds of resource: an index, one per guardrail, and the error catalogue
 * — the last so an agent can look up what a code means before it ever hits one.
 */

const OVERVIEW_URI = 'beel://guardrails';
const ERRORS_URI = 'beel://guardrails/errors';

export const guardrailResources: Resource[] = [
  {
    uri: OVERVIEW_URI,
    name: 'BeeL fiscal guardrails (index)',
    description:
      'Index of the Spanish-invoicing invariants that govern the BeeL API: invoice ' +
      'lifecycle, void vs rectify, invoice types F1/F2/R1–R5, invoice lines, regime ' +
      'keys, series numbering, NIF validation, VeriFactu gates and multi-NIF accounts.',
    mimeType: 'text/markdown',
  },
  {
    uri: ERRORS_URI,
    name: 'BeeL error codes and what to do about each',
    description:
      'Every BeeL error code an agent can act on, with what it means and the single ' +
      'next action it calls for. Consult it when a call fails, or before a risky one.',
    mimeType: 'text/markdown',
  },
  ...GUARDRAILS.map(
    (g): Resource => ({
      uri: guardrailUri(g.id),
      name: g.title,
      description: g.summary,
      mimeType: 'text/markdown',
    }),
  ),
];

function overviewBody(): string {
  return [
    '# BeeL fiscal guardrails',
    '',
    'Spanish invoicing has invariants that are not visible in a request schema. Read the',
    'relevant guardrail before mutating fiscal data; call `beel_docs_search` for the',
    'exhaustive rules and worked examples.',
    '',
    '## Guardrails',
    '',
    ...GUARDRAILS.map((g) => `- **${g.title}** — ${g.summary}\n  \`${guardrailUri(g.id)}\``),
    '',
    '## Error codes',
    '',
    `\`${ERRORS_URI}\` explains every error code this API answers with, and what each one`,
    'calls for. A subset is checked before the request is even sent, so those arrive as a',
    'refusal from this server rather than as an API error.',
  ].join('\n');
}

function errorsBody(): string {
  const byActor: Record<string, string[]> = {
    request: ['## Fix the request and retry', ''],
    configuration: ['## Account configuration — a human must change something', ''],
    access: ['## Access or quota — retrying unchanged will not help', ''],
    benign: ['## Not a failure — the operation already happened, or is in flight', ''],
  };

  for (const code of catalogCodes()) {
    const entry = ERROR_CATALOG[code]!;
    const lines = [
      `### \`${code}\``,
      '',
      entry.meaning,
      '',
      `**Do this:** ${entry.remedy}`,
    ];
    if (entry.guardrail) lines.push('', `Background: \`${guardrailUri(entry.guardrail)}\``);
    lines.push('');
    byActor[entry.actor]!.push(...lines);
  }

  return [
    '# BeeL error codes',
    '',
    'What each code means and the one action it calls for, grouped by who has to act.',
    'Errors carry their specifics in `error.details`.',
    '',
    ...Object.values(byActor).flat(),
  ].join('\n');
}

/** Resolve a guardrail resource URI to its Markdown; null if unknown. */
export function readGuardrailResource(uri: string): string | null {
  if (uri === OVERVIEW_URI) return overviewBody();
  if (uri === ERRORS_URI) return errorsBody();
  if (!uri.startsWith(GUARDRAIL_URI_PREFIX)) return null;
  const doc = findGuardrail(uri.slice(GUARDRAIL_URI_PREFIX.length));
  if (!doc) return null;
  return `# ${doc.title}\n\n${doc.body}\n\n---\n\nCanonical documentation: ${doc.docPath}`;
}
