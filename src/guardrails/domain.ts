/**
 * Domain guardrails — the fiscal invariants that a blindly auto-generated MCP
 * would miss. They are exposed to agents as MCP resources and woven into tool
 * descriptions (see enrich.ts).
 *
 * The prose lives in `rules/*.md`, one file per guardrail, embedded at build time
 * as text modules (Node via tsup, the Worker via a wrangler Text rule). Keeping it
 * out of TypeScript means the fiscal wording can be reviewed and corrected by
 * people who do not read TypeScript — which matters, because it drifts: this file
 * once described correctives as an invoice `type`, which the API has never accepted.
 *
 * These are deliberately concise; the exhaustive version lives in the docs and is
 * reachable at runtime through `beel_docs_search` / `beel_docs_get`. For the
 * invariants that are *enforced* rather than merely described, see `validate.ts`.
 */

import invoiceStateMachine from './rules/invoice-state-machine.md';
import cancelVsRectify from './rules/cancel-vs-rectify.md';
import invoiceTypes from './rules/invoice-types.md';
import regimeKeys from './rules/regime-keys.md';
import nifValidation from './rules/nif-validation.md';
import verifactuGates from './rules/verifactu-gates.md';
import multiNif from './rules/multi-nif.md';

export interface GuardrailDoc {
  /** Stable id, also the last segment of the resource URI. */
  id: string;
  title: string;
  /** Path on the BeeL documentation site for the full version. */
  docPath: string;
  /** Markdown body surfaced to the agent. */
  body: string;
}

export const GUARDRAIL_URI_PREFIX = 'beel://guardrails/';

export function guardrailUri(id: string): string {
  return GUARDRAIL_URI_PREFIX + id;
}

export const GUARDRAILS: GuardrailDoc[] = [
  {
    id: 'invoice-state-machine',
    title: 'Invoice lifecycle & state machine',
    docPath: '/verifactu/submission-states',
    body: invoiceStateMachine,
  },
  {
    id: 'cancel-vs-rectify',
    title: 'Cancel (void) vs amend (rectificativa)',
    docPath: '/verifactu/cancel-and-fix',
    body: cancelVsRectify,
  },
  {
    id: 'invoice-types',
    title: 'Invoice types F1 / F2 / R1–R5 and how BeeL derives the AEAT code',
    docPath: '/verifactu/invoice-types',
    body: invoiceTypes,
  },
  {
    id: 'regime-keys',
    title: 'Tax regime keys (main_tax.regime_key) and cross-field validations',
    docPath: '/verifactu/regime-keys',
    body: regimeKeys,
  },
  {
    id: 'nif-validation',
    title: 'NIF / DNI validation against the AEAT census',
    docPath: '/nif-validation/validateNif',
    body: nifValidation,
  },
  {
    id: 'verifactu-gates',
    title: 'VeriFactu submission — the three gates',
    docPath: '/verifactu/auto-submit',
    body: verifactuGates,
  },
  {
    id: 'multi-nif',
    title: 'Multi-NIF accounts and the Beel-Active-Company header',
    docPath: '/api-reference/multi-nif',
    body: multiNif,
  },
];

export function findGuardrail(id: string): GuardrailDoc | undefined {
  return GUARDRAILS.find((g) => g.id === id);
}
