import type { OperationSpec } from '../spec/manifest.js';
import { GUARDRAILS, guardrailUri } from './domain.js';

/**
 * Wire operations to the guardrails an agent must respect when calling them.
 * Keyed first by exact operationId, then by tag as a fallback. Each entry lists
 * guardrail ids whose one-line summary + resource URI get appended to the tool
 * description, so the constraint travels with the tool the model is about to call.
 */
const BY_OPERATION_ID: Record<string, string[]> = {
  createCompanyInvoice: ['invoice-types', 'regime-keys', 'nif-validation', 'verifactu-gates'],
  patchCompanyInvoice: ['invoice-state-machine'],
  deleteCompanyInvoice: ['invoice-state-machine'],
  voidCompanyInvoice: ['cancel-vs-rectify', 'invoice-state-machine'],
  createCompanyCorrectiveInvoice: ['cancel-vs-rectify', 'invoice-types', 'invoice-state-machine'],
  issueCompanyInvoice: ['invoice-state-machine', 'verifactu-gates'],
  setCompanyInvoiceStatus: ['invoice-state-machine'],
  setCompanyInvoiceSchedule: ['invoice-state-machine'],
  validateNif: ['nif-validation'],
  createCompanyCustomer: ['nif-validation'],
  createCompanyCustomersBulk: ['nif-validation'],
  updateCompanyVeriFactuConfiguration: ['verifactu-gates'],
  getCompanyVeriFactuConfiguration: ['verifactu-gates'],
  createCompany: ['multi-nif', 'nif-validation'],
  listCompanies: ['multi-nif'],
};

const BY_TAG: Record<string, string[]> = {
  CompanyInvoices: ['invoice-state-machine'],
  CompanyInvoiceLifecycle: ['invoice-state-machine', 'cancel-vs-rectify'],
  CompanyProforma: ['invoice-state-machine'],
  CompanyRecurringInvoices: ['invoice-types', 'regime-keys'],
  CompanyVeriFactuConfiguration: ['verifactu-gates'],
  Company: ['multi-nif'],
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
