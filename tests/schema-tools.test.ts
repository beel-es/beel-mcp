import { describe, expect, it } from 'vitest';
import {
  MAX_FIELD_CONSTRAINT_CHARS,
  MAX_FIELD_DESCRIPTION_CHARS,
  fieldDescription,
  MAX_INLINE_ENUM_VALUES,
  declareOperation,
  declareSchema,
  firstSentence,
  schemaNames,
} from '../src/spec/declarations.js';
import { loadSpec, type SpecNode } from '../src/spec/load.js';
import { closestMatches, editDistance } from '../src/shared/similar.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import {
  MAX_LISTED_NAMES,
  MAX_SCHEMAS,
  SCHEMA_GET,
  SchemaQueryError,
  declareAll,
  executeSchemaTool,
  isSchemaTool,
  schemaTools,
} from '../src/tools/schema-tools.js';
import { ArgumentError } from '../src/tools/validate-args.js';

const doc = loadSpec();
const schemas = schemaNames(doc);
const get = (args: Record<string, unknown>) => executeSchemaTool(SCHEMA_GET, args);

/** The declaration of a named schema from the bundled contract. */
function declared(name: string): string {
  const declaration = declareSchema(doc, name);
  if (!declaration) throw new Error(`no schema ${name}`);
  return declaration.text;
}

/** A schema node of the bundled contract, to compare the rendering against its source. */
function schema(name: string): SpecNode {
  return (doc.components as { schemas: Record<string, SpecNode> }).schemas[name]!;
}

describe('firstSentence', () => {
  it('keeps the first sentence on one line, without Markdown emphasis', () => {
    expect(firstSentence('Payment **due** date.\nMust be after the issue date.')).toBe(
      'Payment due date.',
    );
  });

  it('does not end a sentence at "e.g." and stops at a colon that opens a list', () => {
    expect(firstSentence('An email, e.g. a@b.co, of 5 chars. More.')).toBe(
      'An email, e.g. a@b.co, of 5 chars.',
    );
    expect(firstSentence('Tax type by territory:\n- IVA: peninsula\n- IGIC: Canarias')).toBe(
      'Tax type by territory:',
    );
  });

  it(`cuts at ${MAX_FIELD_DESCRIPTION_CHARS} characters and says so`, () => {
    const text = firstSentence(`${'word '.repeat(60)}end.`);
    expect(text.length).toBe(MAX_FIELD_DESCRIPTION_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(firstSentence(undefined)).toBe('');
  });
});

describe('fieldDescription', () => {
  it('keeps the sentences that say what is required or rejected, after the first', () => {
    const text = fieldDescription(
      'Invoice type to create. Some background. `CORRECTIVE` is **not** accepted here. More prose.',
    );
    expect(text).toBe('Invoice type to create. `CORRECTIVE` is not accepted here.');
  });

  it('keeps a sentence that names an error code', () => {
    expect(fieldDescription('A rate. A wrong one answers `422 SURCHARGE_REQUIRES_REGIME`.')).toBe(
      'A rate. A wrong one answers `422 SURCHARGE_REQUIRES_REGIME`.',
    );
  });

  it('does not end a sentence at "art." or "e.g."', () => {
    const text = fieldDescription(
      'A line. Forbidden on SUPLIDO lines (art. 78 LIVA), e.g. a disbursement. Other text.',
    );
    expect(text).toBe('A line. Forbidden on SUPLIDO lines (art. 78 LIVA), e.g. a disbursement.');
  });

  it(`stays within ${MAX_FIELD_CONSTRAINT_CHARS} characters, cutting a long rule at a clause`, () => {
    const long =
      `Main tax. It is never defaulted: omitting it is rejected with \`LINE_MAIN_TAX_REQUIRED\`, ` +
      `and ${'is never filled in from a setting '.repeat(10)}.`;
    const text = fieldDescription(long);
    expect(text.length).toBeLessThanOrEqual(MAX_FIELD_CONSTRAINT_CHARS);
    expect(text).toBe(
      'Main tax. It is never defaulted: omitting it is rejected with `LINE_MAIN_TAX_REQUIRED`.',
    );
  });

  it('never cuts inside a list, where its first item alone would say the opposite', () => {
    const text = fieldDescription(
      'A total. ' +
        `${'x'.repeat(150)} Each line must carry exactly one of \`unit_price\`, \`total\` or \`gross\` ` +
        'and nothing else, otherwise it is rejected with `LINE_UNIT_PRICE_XOR_DECLARED_TOTAL`.',
    );
    expect(text).not.toMatch(/exactly one of `unit_price`\./);
  });
});

describe('declarations', () => {
  it('write an object as an interface: required, optional, format, enum inline', () => {
    const text = declared('CreateInvoiceRequest');
    expect(text).toMatch(/^interface CreateInvoiceRequest \{$/m);
    expect(text).toMatch(/^ {2}type: "STANDARD" \| "CORRECTIVE" \| "SIMPLIFIED" \| "PROFORMA";/m);
    expect(text).toMatch(/^ {2}series_id\?: string; \/\/ uuid — /m);
    expect(text).toMatch(/^ {2}due_date\?: string; \/\/ date — Payment due date\. /m);
    expect(text).toMatch(/^ {2}recipient: Recipient;/m);
  });

  it('follow the required list of the contract, field by field', () => {
    const node = schema('Address');
    const required = new Set(node.required as string[]);
    const text = declared('Address');
    for (const field of Object.keys(node.properties as object)) {
      const optional = required.has(field) ? '' : '\\?';
      expect(text, field).toMatch(new RegExp(`^ {2}${field}${optional}: `, 'm'));
    }
  });

  it('write an inline object where it is used, one level deeper', () => {
    const text = declared('CreateInvoiceRequest');
    expect(text).toMatch(/^ {2}lines: Array<\{$/m);
    expect(text).toMatch(/^ {4}quantity: number;/m);
    expect(text).toMatch(/^ {4}line_type\?: "NORMAL" \| "SUPLIDO"; \/\/ default "NORMAL" — /m);
    expect(text).toMatch(/^ {2}\}>;/m);
  });

  it('name a referenced object without expanding it, and report the reference', () => {
    const recipient = declareSchema(doc, 'Recipient')!;
    expect(recipient.text).toMatch(/^ {2}alternative_id\?: AlternativeIdentifier;/m);
    expect(recipient.text).not.toContain('interface AlternativeIdentifier');
    expect(recipient.references).toEqual(['AlternativeIdentifier', 'Address']);
  });

  it('keep the requirement that is not the first sentence, and mark the field', () => {
    const text = declared('CreateInvoiceRequest');
    expect(text).toMatch(/^ {2}type: [^\n]*`CORRECTIVE` is not accepted here/m);
    expect(text).toMatch(
      /^ {4}main_tax\?: TaxInfo; \/\/ conditionally required — [^\n]*Mandatory on `NORMAL` lines\.[^\n]*`422 LINE_MAIN_TAX_REQUIRED`/m,
    );
    // Required in the schema: no mark, the missing `?` says it.
    expect(text).not.toMatch(/^ {2}recipient: [^\n]*conditionally required/m);
  });

  it('inline a named scalar or short enum, and name a long enum', () => {
    // Email is a string: a name would cost a call to learn that.
    expect(declared('Recipient')).toMatch(/^ {2}email\?: string;/m);
    expect((schema('RegimeKey').enum as unknown[]).length).toBeGreaterThan(MAX_INLINE_ENUM_VALUES);
    expect(declared('TaxInfo')).toMatch(/^ {2}regime_key\?: RegimeKey;/m);
    expect(declared('TaxInfo')).toMatch(/^ {2}type: "IVA" \| "IGIC" \| "IPSI" \| "OTHER";/m);
  });

  it('write a named enum whole where it is declared', () => {
    const values = (schema('RegimeKey').enum as string[]).map((v) => `"${v}"`).join(' | ');
    expect(declared('RegimeKey')).toContain(`type RegimeKey = ${values};`);
  });

  it('mark nullable fields and write numbers as number, noting integers', () => {
    expect(declared('Recipient')).toMatch(/^ {2}trade_name\?: string \| null;/m);
    const list = buildApiTools().tools.find((t) => t.tool.name === 'beel_list_invoices')!;
    const query = declareOperation(doc, list.operation, list.tool.name).text;
    expect(query).toMatch(/^ {2}page\?: number; \/\/ integer, default 1 — /m);
  });

  it('write an allOf over a named base as extends', () => {
    expect(declared('Invoice')).toMatch(/^interface Invoice extends InvoiceBase \{$/m);
    expect(declared('Invoice')).toMatch(/^ {2}id: string; \/\/ uuid/m);
  });

  it('write a oneOf as a union of names', () => {
    expect(declared('WebhookEvent')).toMatch(
      /^ {2}data: WebhookEventDataInvoiceIssued \| WebhookEventDataInvoiceEmailSent \| /m,
    );
  });

  it('open with the first sentence of the schema description', () => {
    expect(declared('AlternativeIdentifier').split('\n')[0]).toBe(
      `// ${firstSentence(schema('AlternativeIdentifier').description)}`,
    );
  });

  it('are a pure function of the contract', () => {
    for (const name of schemas) {
      expect(declareSchema(doc, name)!.text, name).toBe(declareSchema(doc, name)!.text);
    }
    expect(declareSchema(doc, 'NoSuchSchema')).toBeUndefined();
  });
});

describe('operation declarations', () => {
  const tool = (name: string) => buildApiTools().tools.find((t) => t.tool.name === name)!;
  const declare = (name: string) =>
    declareOperation(doc, tool(name).operation, tool(name).tool.name);

  it('give the body schema in full and the type the call returns', () => {
    const { text } = declare('beel_create_invoice');
    expect(text.split('\n')[0]).toBe(
      '// beel_create_invoice: POST /v1/companies/{company_id}/invoices → returns Invoice',
    );
    expect(text).toContain('// body: CreateInvoiceRequest');
    expect(text).toMatch(/^interface CreateInvoiceRequest \{$/m);
  });

  it('give the query parameters as an interface, and an inline response a name', () => {
    const { text, references } = declare('beel_list_invoices');
    expect(text).toContain('→ returns ListCompanyInvoicesData');
    expect(text).toMatch(/^type ListCompanyInvoicesData = \{\n {2}invoices: Invoice\[\];/m);
    expect(text).toMatch(/^interface ListCompanyInvoicesQuery \{$/m);
    expect(text).toMatch(/^ {2}status\?: Array<"SCHEDULED" \| /m);
    expect(references).toContain('Invoice');
  });

  it('say so when an operation takes neither query nor body', () => {
    const bare = buildApiTools().tools.find(
      (t) => !t.operation.requestBody && t.operation.queryParams.length === 0,
    )!;
    expect(declareOperation(doc, bare.operation, bare.tool.name).text).toContain(
      '// no query parameters and no body',
    );
  });
});

describe(`${SCHEMA_GET}`, () => {
  it('is a read-only tool over the bundled contract', () => {
    expect(isSchemaTool(SCHEMA_GET)).toBe(true);
    expect(schemaTools[0]!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('declares several schemas in one call, in the order asked, each once', async () => {
    const text = await get({ name: 'TaxInfo', names: ['Address', 'taxinfo', 'Address'] });
    expect(text.indexOf('interface TaxInfo')).toBeLessThan(text.indexOf('interface Address'));
    expect(text.split('interface TaxInfo')).toHaveLength(2);
    expect(text.split('interface Address')).toHaveLength(2);
  });

  it('names the referenced schemas it did not show, for one follow-up call', async () => {
    const text = await get({ names: ['Recipient', 'Address'] });
    expect(text).toMatch(/Referenced, not shown: AlternativeIdentifier\. Read them with names\.$/);
  });

  it('takes a tool name or an operationId for the operation', async () => {
    const byTool = await get({ name: 'beel_create_invoice' });
    expect(byTool).toContain('// body: CreateInvoiceRequest');
    expect(await get({ name: 'createCompanyInvoice' })).toBe(byTool);
  });

  it('offers close matches for an unknown name, without failing the others', async () => {
    const text = await get({ names: ['TaxInfo', 'CreateInvoiceRequst'] });
    expect(text).toContain('interface TaxInfo');
    expect(text).toMatch(
      /No schema, tool or operationId "CreateInvoiceRequst"\. Close matches: CreateInvoiceRequest/,
    );
  });

  it('fails a call whose every name is unknown, saying how to list names', async () => {
    const call = get({ name: 'Nonexistent' });
    await expect(call).rejects.toBeInstanceOf(SchemaQueryError);
    await expect(get({ name: 'Nonexistent' })).rejects.toThrow(/List schema names with query/);
  });

  it('lists the schema names that contain a query', async () => {
    const text = await get({ query: 'recipient' });
    const listed = text.split('\n')[0]!;
    expect(listed).toMatch(/^\d+ schema names contain "recipient": /);
    expect(listed).toContain('Recipient');
    expect(listed).not.toContain('Address,');
  });

  it(`lists at most ${MAX_LISTED_NAMES} names and says how many it left out`, async () => {
    const all = schemas.filter((n) => n.toLowerCase().includes('e'));
    expect(all.length).toBeGreaterThan(MAX_LISTED_NAMES);
    const text = await get({ query: 'e' });
    expect(text).toContain(`Truncated: ${all.length - MAX_LISTED_NAMES} more not shown`);
  });

  it('answers a query that matches nothing with close names', async () => {
    expect(await get({ query: 'Adress' })).toMatch(
      /No schema name contains "Adress"\. Close matches: Address/,
    );
  });

  it('still lists when every name is unknown but a query was given', async () => {
    const text = await get({ name: 'Nonexistent', query: 'TaxInfo' });
    expect(text).toContain('No schema, tool or operationId "Nonexistent"');
    expect(text).toContain('schema names contain "TaxInfo"');
  });

  it('asks for a name or a query when given neither', async () => {
    await expect(get({})).rejects.toBeInstanceOf(ArgumentError);
    await expect(get({})).rejects.toThrow(/pass name or names/);
  });

  it(`takes at most ${MAX_SCHEMAS} names`, async () => {
    const names = schemas.slice(0, MAX_SCHEMAS + 1);
    await expect(get({ names })).rejects.toThrow(/names/);
  });

  it('stops before the output limit and names what it left out', () => {
    const { text } = declareAll(['CreateInvoiceRequest', 'TaxInfo', 'Address'], schemas, 4_900);
    expect(text).toContain('interface CreateInvoiceRequest');
    expect(text).toContain('interface TaxInfo');
    expect(text).toContain(
      'Not shown, over the output limit: Address. Ask for them in another call.',
    );
  });
});

describe('close matches', () => {
  it('measure edits', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
  });

  it('prefer names that contain the query, then the fewest edits, ignoring case', () => {
    const names = ['InvoiceLine', 'Invoice', 'Address', 'AddressResponse', 'Invoices'];
    expect(closestMatches('invoice', names, 3)).toEqual(['Invoice', 'Invoices', 'InvoiceLine']);
    expect(closestMatches('Adress', names, 5)).toEqual(['Address']);
    expect(closestMatches('zzzz', names, 5)).toEqual([]);
    expect(closestMatches('  ', names, 5)).toEqual([]);
  });
});
