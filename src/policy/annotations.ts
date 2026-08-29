import type { OperationSpec } from '../spec/manifest.js';
import { BEEL_HEADER } from '../shared/defaults.js';

/**
 * MCP tool annotations: behavioural hints a client uses to decide how to surface
 * a tool — chiefly whether to ask a human before calling it. They are advisory,
 * never a security boundary, and their value is entirely in being *selective*:
 * a `destructiveHint` on everything trains a host to confirm nothing.
 *
 * So the verdict is derived, in order of authority: what the contract says, what
 * the HTTP verb means, what the operation's own prose claims, and only then a
 * short hand-kept list for what none of those can see.
 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Prose that states irreversibility outright. Deliberately narrow: "AEAT" also
 * appears in every invoice description, in NIF validation and in read-only
 * readiness checks, so treating a mention of the tax authority as a signal would
 * mark most of the surface destructive and the hint would stop meaning anything.
 */
export const IRREVERSIBLE_PHRASES: readonly string[] = [
  'cannot be undone',
  'cannot be reversed',
  'cannot be reissued',
  'irreversible',
];

/**
 * Operations that are irreversible or fiscally final without saying so and
 * without a verb that implies it: a POST that burns an invoice number, sends a
 * registro to AEAT, spends a one-time secret or hands a document to a signer.
 *
 * Every entry is checked by `tests/annotations.test.ts` against the contract —
 * both that it still names a real operation, and that no heuristic already
 * covers it, so the list only ever holds what nothing else can derive. It
 * shrinks to nothing the day the contract declares `x-irreversible` itself.
 */
export const DESTRUCTIVE_OPERATION_IDS = new Set([
  // Burns the invoice number and reports the cancellation to AEAT.
  'voidCompanyInvoice',
  // Issues a new fiscal document and moves the original to RECTIFIED or VOIDED.
  'createCompanyCorrectiveInvoice',
  // Turns the proforma terminal (CONVERTED) and issues a numbered invoice.
  'convertCompanyProformaToInvoice',
  // Issues the next occurrence early; the schedule advances past it.
  'generateCompanyRecurringInvoiceNow',
  // Hands the representation to the signer; a submitted document is not withdrawn.
  'submitCompanyRepresentation',
  // Invalidates the existing secret immediately, breaking every live receiver.
  'rotateAccountWebhookSecret',
]);

function titleCase(operationId: string): string {
  return operationId.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Does the operation's own prose claim it cannot be undone? */
function claimsIrreversible(op: OperationSpec): boolean {
  const prose = `${op.summary} ${op.description}`.toLowerCase();
  return IRREVERSIBLE_PHRASES.some((phrase) => prose.includes(phrase));
}

function isDestructive(op: OperationSpec): boolean {
  // The contract is the author: an explicit verdict, either way, ends it.
  if (op.irreversible !== undefined) return op.irreversible;
  // A read never destroys anything, whatever its prose describes.
  if (op.method === 'GET') return false;
  if (op.method === 'DELETE') return true;
  return claimsIrreversible(op) || DESTRUCTIVE_OPERATION_IDS.has(op.operationId);
}

/**
 * HTTP defines GET, PUT and DELETE as idempotent and POST and PATCH as not.
 * PATCH is the one worth stating: its body may be a delta, so repeating it
 * repeats the change. A POST is idempotent only where the contract offers an
 * Idempotency-Key, which is exactly the promise the verb withholds.
 */
function isIdempotent(op: OperationSpec): boolean {
  if (op.method === 'GET' || op.method === 'PUT' || op.method === 'DELETE') return true;
  if (op.method === 'PATCH') return false;
  return op.headerParams.some((p) => p.name === BEEL_HEADER.idempotencyKey);
}

export function annotationsFor(op: OperationSpec): ToolAnnotations {
  return {
    title: titleCase(op.operationId),
    readOnlyHint: op.method === 'GET',
    destructiveHint: isDestructive(op),
    idempotentHint: isIdempotent(op),
    openWorldHint: true, // every tool talks to the live BeeL API
  };
}
