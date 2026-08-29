import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';
import {
  annotationsFor,
  DESTRUCTIVE_OPERATION_IDS,
  IRREVERSIBLE_PHRASES,
} from '../src/policy/annotations.js';
import { operationIds } from '../src/spec/operation-ids.js';

const manifest = buildManifest(loadSpec());
const byId = (id: string): OperationSpec => {
  const op = manifest.find((o) => o.operationId === id);
  if (!op) throw new Error(`operation ${id} not found in manifest`);
  return op;
};

const stub = (over: Partial<OperationSpec>): OperationSpec => ({
  operationId: 'doThing',
  method: 'POST',
  path: '/v1/things',
  tags: ['Things'],
  summary: 'Do a thing',
  description: '',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  successContentTypes: ['application/json'],
  binaryResponse: false,
  deprecated: false,
  scopes: [],
  securitySchemes: ['ApiKeyAuth'],
  irreversible: undefined,
  ...over,
});

describe('destructiveHint', () => {
  it('trusts the contract when it says so', () => {
    expect(annotationsFor(stub({ irreversible: true })).destructiveHint).toBe(true);
    // An explicit `false` outranks every heuristic: the contract is the author.
    expect(annotationsFor(stub({ method: 'DELETE', irreversible: false })).destructiveHint).toBe(
      false,
    );
  });

  it('treats a DELETE as destructive', () => {
    expect(annotationsFor(stub({ method: 'DELETE' })).destructiveHint).toBe(true);
  });

  it('reads the operation prose for an irreversibility claim', () => {
    for (const phrase of IRREVERSIBLE_PHRASES) {
      expect(
        annotationsFor(stub({ description: `Note: this ${phrase} later.` })).destructiveHint,
        phrase,
      ).toBe(true);
    }
  });

  it('does not read prose on a read-only operation', () => {
    // A GET describing what cannot be undone is describing something else.
    expect(
      annotationsFor(stub({ method: 'GET', description: 'This cannot be undone.' }))
        .destructiveHint,
    ).toBe(false);
  });

  it('leaves an ordinary create alone', () => {
    expect(annotationsFor(byId('createCompanyCustomer')).destructiveHint).toBe(false);
    expect(annotationsFor(byId('listCompanyInvoices')).destructiveHint).toBe(false);
  });

  it('covers the fiscally irreversible operations the heuristics cannot see', () => {
    const required = [
      'voidCompanyInvoice',
      'createCompanyCorrectiveInvoice',
      'cancelCompanyRepresentation',
      'issueCompanyInvoice',
      'convertCompanyProformaToInvoice',
      'generateCompanyRecurringInvoiceNow',
      'deactivateCompanyById',
      'endAccountManagement',
      'disconnectCompanyPaymentConnection',
      'rotateAccountWebhookSecret',
      'submitCompanyRepresentation',
    ];
    const missed = required.filter((id) => !annotationsFor(byId(id)).destructiveHint);
    expect(missed).toEqual([]);
  });

  it('keeps the explicit list minimal and resolvable', () => {
    // Every entry must name a real operation...
    expect([...DESTRUCTIVE_OPERATION_IDS].filter((id) => !operationIds().has(id))).toEqual([]);
    // ...and earn its place: an entry a heuristic already covers is a second
    // copy of the same decision, and the one that rots unnoticed.
    const redundant = [...DESTRUCTIVE_OPERATION_IDS].filter((id) => {
      const op = byId(id);
      return annotationsFor({ ...op, operationId: 'notListed' }).destructiveHint;
    });
    expect(redundant).toEqual([]);
  });
});

describe('idempotentHint', () => {
  it('is true for the methods HTTP defines as idempotent', () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expect(annotationsFor(stub({ method })).idempotentHint, method).toBe(true);
    }
  });

  it('is false for PATCH, which HTTP does not define as idempotent', () => {
    // A PATCH body may be a delta ("add a line"), and repeating it repeats the
    // change. Nothing in the method guarantees otherwise.
    expect(annotationsFor(stub({ method: 'PATCH' })).idempotentHint).toBe(false);
  });

  it('is true for a POST the contract lets the caller key', () => {
    // An Idempotency-Key is exactly the promise the verb does not make.
    const keyed = stub({
      headerParams: [
        { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
      ],
    });
    expect(annotationsFor(keyed).idempotentHint).toBe(true);
    expect(annotationsFor(stub({})).idempotentHint).toBe(false);
  });
});
