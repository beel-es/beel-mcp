import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';
import { buildInputSchema } from '../src/spec/json-schema.js';

const doc = loadSpec();
const manifest = buildManifest(doc);
const byId = (id: string): OperationSpec => manifest.find((o) => o.operationId === id)!;

describe('buildInputSchema', () => {
  it('nests a JSON body under "body" and marks it required', () => {
    const schema = buildInputSchema(byId('createInvoice'), doc);
    expect(schema.properties.body).toBeDefined();
    expect(schema.required).toContain('body');
  });

  it('rewrites every $ref into local #/$defs (no #/components leftovers)', () => {
    const schema = buildInputSchema(byId('createInvoice'), doc);
    const serialised = JSON.stringify(schema);
    expect(serialised).not.toContain('#/components/');
    if (serialised.includes('$ref')) expect(serialised).toContain('#/$defs/');
    expect(Object.keys(schema.$defs ?? {}).length).toBeGreaterThan(0);
  });

  it('produces a JSON-serialisable schema even with recursive refs', () => {
    for (const op of manifest) {
      expect(() => JSON.stringify(buildInputSchema(op, doc))).not.toThrow();
    }
  });

  it('makes path params required top-level properties', () => {
    const schema = buildInputSchema(byId('getInvoice'), doc);
    expect(schema.properties.invoice_id).toBeDefined();
    expect(schema.required).toContain('invoice_id');
  });

  it('surfaces query params as optional properties', () => {
    const schema = buildInputSchema(byId('listInvoices'), doc);
    expect(schema.properties.page).toBeDefined();
    expect(schema.required ?? []).not.toContain('page');
  });
});

describe('OpenAPI 3.0 → JSON Schema normalisation', () => {
  it('converts boolean exclusive bounds into the numeric JSON Schema form', () => {
    const doc = {
      components: {
        schemas: {
          Price: {
            type: 'object',
            properties: {
              unit_price: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false },
            },
          },
        },
      },
    } as never;
    const op = {
      operationId: 'x',
      method: 'POST',
      path: '/x',
      tag: 'X',
      summary: '',
      pathParams: [],
      queryParams: [],
      scopes: [],
      requestBody: { contentType: 'application/json', required: true, schema: { $ref: '#/components/schemas/Price' } },
    } as never;
    const schema = buildInputSchema(op, doc);
    const price = (schema.$defs as Record<string, { properties: Record<string, Record<string, unknown>> }>).Price;
    expect(price?.properties.unit_price).toEqual({ type: 'number', exclusiveMinimum: 0, maximum: 10 });
  });
});
