import type { OperationSpec } from '../spec/manifest.js';
import { GUARDRAILS, guardrailUri } from './domain.js';

/**
 * Wire operations to the guardrails an agent must respect when calling them.
 * Keyed first by exact operationId, then by tag as a fallback. Each entry lists
 * guardrail ids whose one-line summary + resource URI get appended to the tool
 * description, so the constraint travels with the tool the model is about to call.
 */
const BY_OPERATION_ID: Record<string, string[]> = {
  createInvoice: ['invoice-types', 'regime-keys', 'nif-validation', 'verifactu-gates'],
  updateInvoice: ['invoice-state-machine'],
  deleteInvoice: ['invoice-state-machine'],
  voidInvoice: ['cancel-vs-rectify', 'invoice-state-machine'],
  createCorrectiveInvoice: ['cancel-vs-rectify', 'invoice-types', 'invoice-state-machine'],
  markInvoicePaid: ['invoice-state-machine'],
  markInvoiceSent: ['invoice-state-machine'],
  revertInvoiceToIssued: ['invoice-state-machine'],
  scheduleInvoice: ['invoice-state-machine'],
  validateNif: ['nif-validation'],
  createCustomer: ['nif-validation'],
  createCustomersBulk: ['nif-validation'],
  updateVeriFactuConfiguration: ['verifactu-gates'],
  getVeriFactuConfiguration: ['verifactu-gates'],
  createCompany: ['multi-nif', 'nif-validation'],
  listCompanies: ['multi-nif'],
};

const BY_TAG: Record<string, string[]> = {
  Invoices: ['invoice-state-machine'],
  InvoiceLifecycle: ['invoice-state-machine', 'cancel-vs-rectify'],
  RecurringInvoices: ['invoice-types', 'regime-keys'],
  ConfigurationVeriFactu: ['verifactu-gates'],
  PublicCompanies: ['multi-nif'],
};

function guardrailIdsFor(op: OperationSpec): string[] {
  const fromId = BY_OPERATION_ID[op.operationId];
  if (fromId) return fromId;
  return BY_TAG[op.tag] ?? [];
}

const ONE_LINER: Record<string, string> = Object.fromEntries(
  GUARDRAILS.map((g) => [g.id, g.title]),
);

/**
 * Build the full tool description: the operation's own summary/description plus a
 * "Fiscal guardrails" footer linking the relevant guardrail resources. Always
 * nudges toward `beel_docs_search` for the exhaustive rules.
 */
export function describeTool(op: OperationSpec): string {
  const base = op.description?.trim() || op.summary;
  const ids = guardrailIdsFor(op);
  if (ids.length === 0) {
    return `${base}\n\nEndpoint: ${op.method} ${op.path}`;
  }
  const lines = ids
    .filter((id) => ONE_LINER[id])
    .map((id) => `- ${ONE_LINER[id]} (resource: ${guardrailUri(id)})`);
  return [
    base,
    '',
    `Endpoint: ${op.method} ${op.path}`,
    '',
    '⚠️ Fiscal guardrails — read before calling:',
    ...lines,
    '',
    'For the exhaustive rules and worked examples, call beel_docs_search.',
  ].join('\n');
}

/** The guardrail ids relevant to an operation (exposed for tests/introspection). */
export function guardrailsForOperation(op: OperationSpec): string[] {
  return guardrailIdsFor(op);
}
