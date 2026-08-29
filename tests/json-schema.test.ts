import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';
import { buildInputSchema } from '../src/spec/json-schema.js';

const doc = loadSpec();
const manifest = buildManifest(doc);
const byId = (id: string): OperationSpec => manifest.find((o) => o.operationId === id)!;

/** A minimal operation, for the projections that need a schema the contract does not hold. */
const stubOperation = (over: Partial<OperationSpec>): OperationSpec => ({
  operationId: 'doThing',
  method: 'POST',
  path: '/x',
  tags: ['X'],
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
  irreversible: undefined,
  ...over,
});

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

  it('omits readOnly properties, which a request may not carry', () => {
    // A readOnly field is the server's answer, not the caller's input. Offered
    // in an inputSchema it reads as something the model may set, and the model
    // sets it: `numbering_locked` and `next_number` (from the contract's
    // InvoiceSeries) are exactly the fields a series refuses to be told. No
    // request schema reaches one today, which is why this is a fixture: the
    // guarantee has to hold the day a response schema is reused as a request.
    const series = {
      components: {
        schemas: {
          Series: {
            type: 'object',
            required: ['code', 'numbering_locked'],
            properties: {
              code: { type: 'string' },
              numbering_locked: { type: 'boolean', readOnly: true },
              next_number: { type: 'integer', readOnly: true },
            },
          },
        },
      },
    } as never;
    const schema = buildInputSchema(
      stubOperation({
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: { $ref: '#/components/schemas/Series' },
        },
      }),
      series,
    );
    const serialised = JSON.stringify(schema);
    expect(serialised).not.toContain('numbering_locked');
    expect(serialised).not.toContain('next_number');
    expect(serialised).toContain('code');
  });

  it('never leaves a dropped property behind in `required`', () => {
    // A required property that does not exist makes the whole schema
    // unsatisfiable: every call fails validation before it is sent.
    for (const op of manifest) {
      const schema = buildInputSchema(op, doc);
      const check = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(check);
        if (!node || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        if (Array.isArray(record.required) && record.properties) {
          const properties = record.properties as Record<string, unknown>;
          for (const name of record.required) {
            expect(
              typeof name === 'string' && name in properties,
              `${op.operationId}: ${String(name)}`,
            ).toBe(true);
          }
        }
        Object.values(record).forEach(check);
      };
      check(schema.$defs ?? {});
    }
  });

  it('closes every inputSchema to properties it did not declare', () => {
    // An open schema lets an invented argument through to the API, which
    // answers 400 for a field the model believed in. Closed, the client's own
    // validator says so before the call.
    for (const op of manifest) {
      expect(buildInputSchema(op, doc).additionalProperties, op.operationId).toBe(false);
    }
  });

  it('respects the contract when it declares a body open', () => {
    const permissive = {
      components: {
        schemas: {
          Bag: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: true,
          },
          Closed: { type: 'object', properties: { a: { type: 'string' } } },
        },
      },
    } as never;
    const defs = (name: string) =>
      (
        buildInputSchema(
          stubOperation({
            requestBody: {
              contentType: 'application/json',
              required: true,
              schema: { $ref: `#/components/schemas/${name}` },
            },
          }),
          permissive,
        ).$defs as Record<string, Record<string, unknown>>
      )[name]!;
    expect(defs('Bag').additionalProperties).toBe(true);
    expect(defs('Closed').additionalProperties).toBe(false);
  });

  it('keeps a nullable $ref nullable', () => {
    // `{$ref, nullable: true}` is the OpenAPI 3.0 spelling; a $ref with a
    // sibling keyword has no JSON Schema meaning, so the null is lost unless
    // the pair becomes an explicit anyOf.
    const nullableRef = {
      components: {
        schemas: {
          Reason: { type: 'string', enum: ['A', 'B'] },
          Line: {
            type: 'object',
            properties: {
              exemption_reason: { $ref: '#/components/schemas/Reason', nullable: true },
              skip_reason: { allOf: [{ $ref: '#/components/schemas/Reason' }], nullable: true },
            },
          },
        },
      },
    } as never;
    const defs = buildInputSchema(
      stubOperation({
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: { $ref: '#/components/schemas/Line' },
        },
      }),
      nullableRef,
    ).$defs as Record<string, { properties: Record<string, unknown> }>;
    expect(defs.Line?.properties.exemption_reason).toEqual({
      anyOf: [{ $ref: '#/$defs/Reason' }, { type: 'null' }],
    });
    expect(defs.Line?.properties.skip_reason).toEqual({
      anyOf: [{ allOf: [{ $ref: '#/$defs/Reason' }] }, { type: 'null' }],
    });
  });

  it('carries no examples, which are payload the model does not need', () => {
    // Every tool definition is sent on every request, so the schemas compete
    // for the same context the conversation needs. The descriptions are the
    // part that teaches; the examples restate them in bytes.
    const projected = JSON.stringify(manifest.map((op) => buildInputSchema(op, doc)));
    expect(projected).not.toContain('"example"');
    expect(projected).not.toContain('"examples"');

    // What that is worth, measured rather than claimed.
    console.log(
      `inputSchema payload across ${manifest.length} operations: ${projected.length} bytes; ` +
        `the examples dropped from components.schemas were ${exampleBytes(doc)} of them`,
    );
  });
});

/** Serialised size of every `example`/`examples` the schema components carry. */
function exampleBytes(document: unknown): number {
  let bytes = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'example' || key === 'examples') bytes += JSON.stringify(value).length;
      else walk(value);
    }
  };
  walk((document as { components?: { schemas?: unknown } }).components?.schemas);
  return bytes;
}

describe('OpenAPI 3.0 → JSON Schema normalisation', () => {
  it('converts boolean exclusive bounds into the numeric JSON Schema form', () => {
    const doc = {
      components: {
        schemas: {
          Price: {
            type: 'object',
            properties: {
              unit_price: {
                type: 'number',
                minimum: 0,
                exclusiveMinimum: true,
                maximum: 10,
                exclusiveMaximum: false,
              },
            },
          },
        },
      },
    } as never;
    const schema = buildInputSchema(
      stubOperation({
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: { $ref: '#/components/schemas/Price' },
        },
      }),
      doc,
    );
    const price = (
      schema.$defs as Record<string, { properties: Record<string, Record<string, unknown>> }>
    ).Price;
    expect(price?.properties.unit_price).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 10,
    });
  });
});
