/**
 * The fiscal guardrails: the invariants a blindly generated MCP would miss.
 *
 * Each guardrail is one Markdown file in `rules/`, carrying its own metadata in
 * front matter. Keeping the metadata inside the file it describes means the two
 * cannot fall out of step, and it makes a guardrail editable by anyone who
 * understands Spanish invoicing, whether or not they read TypeScript — which
 * matters, because the fiscal wording is where correctness actually lives.
 *
 * Files are embedded as text at build time (tsup for Node, a wrangler Text rule
 * for the Worker, a plugin for vitest), so there is no filesystem read at runtime.
 *
 * These are the *advisory* layer — read by the model, never enforced. The subset
 * that is actually enforced before a request leaves lives in `validate.ts`, and
 * the errors the API answers with are explained by `catalog.ts`.
 */

import cancelVsRectify from './rules/cancel-vs-rectify.md';
import invoiceLines from './rules/invoice-lines.md';
import invoiceStateMachine from './rules/invoice-state-machine.md';
import invoiceTypes from './rules/invoice-types.md';
import multiNif from './rules/multi-nif.md';
import nifValidation from './rules/nif-validation.md';
import regimeKeys from './rules/regime-keys.md';
import seriesAndNumbering from './rules/series-and-numbering.md';
import verifactuGates from './rules/verifactu-gates.md';

export interface Guardrail {
  /** Stable id, also the last segment of the resource URI and the file name. */
  id: string;
  title: string;
  /** One line, used where only a hint fits (tool description footers). */
  summary: string;
  /** Path on the BeeL documentation site for the exhaustive version. */
  docPath: string;
  /** The Markdown body, front matter stripped. */
  body: string;
}

export const GUARDRAIL_URI_PREFIX = 'beel://guardrails/';

export function guardrailUri(id: string): string {
  return GUARDRAIL_URI_PREFIX + id;
}

/** Raw sources, keyed by the id each file is named after. */
const SOURCES: Record<string, string> = {
  'cancel-vs-rectify': cancelVsRectify,
  'invoice-lines': invoiceLines,
  'invoice-state-machine': invoiceStateMachine,
  'invoice-types': invoiceTypes,
  'multi-nif': multiNif,
  'nif-validation': nifValidation,
  'regime-keys': regimeKeys,
  'series-and-numbering': seriesAndNumbering,
  'verifactu-gates': verifactuGates,
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse the leading `key: value` block. Intentionally minimal rather than a YAML
 * dependency: the fields are three flat strings, and pulling a parser into the
 * Worker bundle to read them would cost more than it explains.
 */
function parse(id: string, source: string): Guardrail {
  const match = FRONT_MATTER.exec(source);
  if (!match) {
    throw new Error(`Guardrail "${id}" has no front matter (expected title/docPath/summary).`);
  }
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  for (const required of ['title', 'docPath', 'summary'] as const) {
    if (!fields[required]) throw new Error(`Guardrail "${id}" is missing "${required}".`);
  }
  return {
    id,
    title: fields.title!,
    docPath: fields.docPath!,
    summary: fields.summary!,
    body: source.slice(match[0].length).trim(),
  };
}

export const GUARDRAILS: Guardrail[] = Object.entries(SOURCES)
  .map(([id, source]) => parse(id, source))
  .sort((a, b) => a.id.localeCompare(b.id));

export function findGuardrail(id: string): Guardrail | undefined {
  return GUARDRAILS.find((g) => g.id === id);
}
