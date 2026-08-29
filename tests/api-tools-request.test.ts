import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildApiTools, collectQuery, substitutePath } from '../src/tools/api-tools.js';
import { ArgumentError } from '../src/tools/validate-args.js';
import type { OperationSpec } from '../src/spec/manifest.js';

function operation(over: Partial<OperationSpec>): OperationSpec {
  return {
    operationId: 'op',
    method: 'GET',
    path: '/v1/x',
    tags: ['Other'],
    summary: '',
    description: '',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    successContentTypes: ['application/json'],
    binaryResponse: false,
    deprecated: false,
    scopes: [],
    securitySchemes: ['ApiKeyAuth'],
    irreversible: false,
    ...over,
  };
}

const param = (name: string): OperationSpec['pathParams'][number] => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
});

describe('path substitution', () => {
  const op = operation({
    path: '/v1/companies/{company_id}/invoices/{invoice_id}',
    pathParams: [param('company_id'), param('invoice_id')],
  });

  it('percent-encodes every value', () => {
    expect(substitutePath(op, { company_id: 'a/b', invoice_id: 'x y' })).toBe(
      '/v1/companies/a%2Fb/invoices/x%20y',
    );
  });

  it('replaces a placeholder that occurs more than once', () => {
    const repeated = operation({
      path: '/v1/a/{id}/b/{id}',
      pathParams: [param('id')],
    });
    expect(substitutePath(repeated, { id: 'z' })).toBe('/v1/a/z/b/z');
  });

  it('refuses an empty value rather than calling a different endpoint', () => {
    // `''` turns /v1/companies/{company_id}/invoices into /v1/companies//invoices,
    // which is a valid path answering about something else.
    expect(() => substitutePath(op, { company_id: '', invoice_id: 'i' })).toThrow(ArgumentError);
  });

  it('refuses a missing or non-string value', () => {
    expect(() => substitutePath(op, { invoice_id: 'i' })).toThrow(/company_id/);
    expect(() => substitutePath(op, { company_id: {}, invoice_id: 'i' })).toThrow(ArgumentError);
  });
});

describe('query parameters', () => {
  const op = operation({
    queryParams: [
      { name: 'status', in: 'query', required: false, schema: { type: 'array' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
    ],
  });

  it('comma-joins an array, as style form / explode false requires', () => {
    expect(collectQuery(op, { status: ['ISSUED', 'PAID'], page: 2 })).toEqual({
      status: 'ISSUED,PAID',
      page: '2',
    });
  });

  it('omits absent parameters instead of sending an empty value', () => {
    expect(collectQuery(op, { status: undefined, page: null })).toEqual({});
  });

  it('only exposes operations whose array query parameters use the supported style', () => {
    const spec = parseYaml(readFileSync('openapi/public-api.yaml', 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string; parameters?: unknown[] }>>;
    };
    const exposed = new Set(buildApiTools().tools.map((t) => t.operation.operationId));
    const offenders: string[] = [];
    for (const item of Object.values(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (typeof op !== 'object' || !op?.operationId || !exposed.has(op.operationId)) continue;
        for (const raw of op.parameters ?? []) {
          const p = raw as {
            in?: string;
            name?: string;
            style?: string;
            explode?: boolean;
            schema?: { type?: string };
          };
          if (p.in !== 'query' || p.schema?.type !== 'array') continue;
          if (p.style !== 'form' || p.explode !== false) {
            offenders.push(`${method} ${op.operationId}.${p.name}: ${p.style}/${p.explode}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the header parameters an operation declares reach the client', () => {
  it('names Idempotency-Key on the operations whose contract documents it', () => {
    const create = buildApiTools().tools.find(
      (t) => t.operation.operationId === 'createCompanyInvoice',
    );
    expect(create?.operation.headerParams.map((p) => p.name)).toContain('Idempotency-Key');
  });

  it('does not name it on an operation whose contract omits it', () => {
    const validate = buildApiTools().tools.find((t) => t.operation.operationId === 'validateNif');
    expect(validate?.operation.headerParams.map((p) => p.name) ?? []).not.toContain(
      'Idempotency-Key',
    );
  });
});
