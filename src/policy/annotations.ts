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
  // With `options.issue_directly` it numbers the invoice and sends it to AEAT.
  'createCompanyInvoice',
  // Issues a full invoice registered with AEAT in exchange for simplified ones.
  'createCompanySimplifiedExchange',
  // Sends an email to arbitrary addresses: a send is not recalled.
  'sendCompanyInvoice',
  'createCompanyInvoiceDelivery',
  'createAccountInvitation',
  'createAccountClaimToken',
  // Delivers a request to an arbitrary URL.
  'testAccountWebhookSubscription',
  'retryAccountWebhookDelivery',
  // Close a payment event or an occurrence; a later restore does not make the
  // first call harmless.
  'discardCompanyPaymentEvent',
  'resolveCompanyPaymentEvent',
  'skipCompanyRecurringInvoice',
  // A recurring invoice is a schedule that issues to AEAT (and may email) on
  // its own; creating one starts that job.
  'createCompanyRecurringInvoice',
  'createCompanyRecurringInvoiceDerivation',
  // In Live it adds the NIF to the paid subscription.
  'activateCompanyById',
]);

/**
 * Writes over a PUT or a PATCH that only add: they create what is missing and
 * leave what exists untouched. Every other PUT and PATCH overwrites state, which
 * is what a host is told to confirm.
 */
export const ADDITIVE_OPERATION_IDS = new Set([
  // Creates the default series that are missing; existing ones are not touched.
  'ensureCompanyDefaultSeries',
]);

/**
 * Non-GET operations that only read or compute: they change nothing anywhere.
 */
export const READ_ONLY_OPERATION_IDS = new Set([
  // Looks the NIF up in the AEAT register; creates nothing.
  'validateNif',
]);

/**
 * Operations that reach outside the user's own BeeL account: a fiscal record
 * sent to or looked up at AEAT, an email to any address, a request to any URL.
 * Everything else is confined to the account the token belongs to, which is
 * what `openWorldHint: false` means: being hosted remotely does not make a tool
 * open-world.
 */
export const OPEN_WORLD_OPERATION_IDS = new Set([
  // AEAT: register lookups and VeriFactu records.
  'validateNif',
  'createCompanyInvoice',
  'issueCompanyInvoice',
  'voidCompanyInvoice',
  'createCompanyCorrectiveInvoice',
  'createCompanySimplifiedExchange',
  'convertCompanyProformaToInvoice',
  'generateCompanyRecurringInvoiceNow',
  'createCompanyInvoiceBatch',
  // Schedules that issue to AEAT and may email the customer on their own.
  'createCompanyRecurringInvoice',
  'createCompanyRecurringInvoiceDerivation',
  'setCompanyInvoiceSchedule',
  'patchCompanyInvoiceSchedule',
  'setCompanyRecurringInvoiceStatus',
  'patchCompanyRecurringInvoice',
  // Email to arbitrary recipients.
  'sendCompanyInvoice',
  'createCompanyInvoiceDelivery',
  'createAccountInvitation',
  'createAccountClaimToken',
  // Requests to arbitrary URLs.
  'createAccountWebhookSubscription',
  'patchAccountWebhookSubscription',
  'testAccountWebhookSubscription',
  'retryAccountWebhookDelivery',
]);

function titleCase(operationId: string): string {
  return operationId.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Does the operation's own prose claim it cannot be undone? */
function claimsIrreversible(op: OperationSpec): boolean {
  const prose = `${op.summary} ${op.description}`.toLowerCase();
  return IRREVERSIBLE_PHRASES.some((phrase) => prose.includes(phrase));
}

function isReadOnly(op: OperationSpec): boolean {
  return op.method === 'GET' || READ_ONLY_OPERATION_IDS.has(op.operationId);
}

/**
 * OpenAI's review reads `destructiveHint` as "deletes, overwrites, cancels,
 * revokes access or sends irreversibly", and allows `false` only for writes that
 * purely add. So a PUT or PATCH counts: it replaces what was there.
 */
function isDestructive(op: OperationSpec): boolean {
  // The contract is the author: an explicit verdict, either way, ends it.
  if (op.irreversible !== undefined) return op.irreversible;
  // A read never destroys anything, whatever its prose describes.
  if (isReadOnly(op)) return false;
  if (op.method === 'DELETE') return true;
  if (op.method === 'PUT' || op.method === 'PATCH') {
    return !ADDITIVE_OPERATION_IDS.has(op.operationId);
  }
  return claimsIrreversible(op) || DESTRUCTIVE_OPERATION_IDS.has(op.operationId);
}

/**
 * HTTP defines GET, PUT and DELETE as idempotent and POST and PATCH as not.
 * PATCH is the one worth stating: its body may be a delta, so repeating it
 * repeats the change. A POST is idempotent only where the contract offers an
 * Idempotency-Key, which is exactly the promise the verb withholds.
 */
function isIdempotent(op: OperationSpec): boolean {
  if (isReadOnly(op)) return true;
  if (op.method === 'GET' || op.method === 'PUT' || op.method === 'DELETE') return true;
  if (op.method === 'PATCH') return false;
  return op.headerParams.some((p) => p.name === BEEL_HEADER.idempotencyKey);
}

export function annotationsFor(op: OperationSpec): ToolAnnotations {
  return {
    title: titleCase(op.operationId),
    readOnlyHint: isReadOnly(op),
    destructiveHint: isDestructive(op),
    idempotentHint: isIdempotent(op),
    openWorldHint: OPEN_WORLD_OPERATION_IDS.has(op.operationId),
  };
}
