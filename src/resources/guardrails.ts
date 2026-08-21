import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import {
  GUARDRAILS,
  GUARDRAIL_URI_PREFIX,
  findGuardrail,
  guardrailUri,
} from '../guardrails/rules.js';
import { ERROR_CATALOG, catalogCodes, docsUrlForCode } from '../guardrails/catalog.js';
import { BEEL_DEFAULTS } from '../shared/defaults.js';

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
      'The BeeL error codes this server can add a tool-call remedy or retry advice to, ' +
      'each linked to its canonical documentation page. Consult it when a call fails.',
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
    const parts = [`- **\`${code}\`** — ${docsUrlForCode(code)}`];
    if (entry.remedy) parts.push(`  ${entry.remedy}`);
    if (entry.guardrail) parts.push(`  Background: \`${guardrailUri(entry.guardrail)}\``);
    byActor[entry.actor]!.push(parts.join('\n'));
  }

  return [
    '# BeeL error codes',
    '',
    'Every BeeL error carries its own documentation link as the RFC 7807 `type` field, and',
    `around 357 codes have a page under \`${BEEL_DEFAULTS.docsUrl}/errors/<CODE>\`. That is the`,
    'canonical explanation of what a code means, in the language you asked for.',
    '',
    'Listed here are only the codes this server can add something to: the tool call that',
    'resolves them, and whether retrying is worth attempting. A code missing from this list',
    "is not an omission — it means the API's own message says everything worth saying.",
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
