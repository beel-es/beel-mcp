import type { OperationSpec } from '../spec/manifest.js';

/**
 * MCP tool annotations (behavioural hints clients use to decide how to surface
 * a tool — e.g. ask for confirmation before a destructive call). Derived from
 * the HTTP method plus a small set of known-destructive lifecycle operations.
 *
 * See the MCP spec: annotations are advisory hints, never a security boundary.
 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Lifecycle mutations that are irreversible or fiscally significant even though
 * their HTTP verb (POST) isn't inherently destructive. Voiding/cancelling and
 * issuing a registered invoice cannot be undone once it reaches AEAT.
 */
const DESTRUCTIVE_OPERATION_IDS = new Set([
  'voidCompanyInvoice',
  'createCompanyCorrectiveInvoice',
  'cancelCompanyRepresentation',
  'revokeCompanyApiKey',
]);

function titleCase(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

export function annotationsFor(op: OperationSpec): ToolAnnotations {
  const isRead = op.method === 'GET';
  const isDelete = op.method === 'DELETE';
  return {
    title: titleCase(op.operationId),
    readOnlyHint: isRead,
    destructiveHint: isDelete || DESTRUCTIVE_OPERATION_IDS.has(op.operationId),
    // GET/PUT/DELETE are idempotent by HTTP semantics; POST creates new state.
    idempotentHint: op.method !== 'POST',
    openWorldHint: true, // every tool talks to the live BeeL API
  };
}
