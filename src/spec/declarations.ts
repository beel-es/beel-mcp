/**
 * Schemas of the bundled contract as compact TypeScript-like declarations.
 *
 * An agent writing code against the API needs the fields of a body: their
 * names, types, which are required, the values an enum takes and what each
 * field is for. The contract says all of that at length, and the same shapes in
 * an SDK's type file or the reference page run to tens of KB. This renders the
 * part a model reads to write a call, one line per field:
 *
 *   interface Recipient {
 *     customer_id?: string; // uuid — UUID of a registered customer.
 *     alternative_id?: AlternativeIdentifier;
 *   }
 *
 * A named object schema is referenced by name and never expanded, so the output
 * of one schema stays bounded and the agent asks for the ones it needs. A named
 * schema that is only a scalar or a short enum is inlined instead: asking what
 * `Email` is would cost a call to learn it is a string. Output is a pure
 * function of the contract: same schema, same text.
 */

import { isRecord } from '../shared/guards.js';
import type { SpecNode } from './load.js';
import type { OperationSpec } from './manifest.js';
import { resolveRef } from './refs.js';

/** Longest description a schema heading carries: its first sentence, cut at this length. */
export const MAX_FIELD_DESCRIPTION_CHARS = 120;
/**
 * Longest description a field carries. Its first sentence, then each later
 * sentence that states a requirement or a rejection, while they fit: the part of
 * a description that decides whether a call is accepted is rarely the first
 * sentence ("Mandatory on NORMAL lines", "CORRECTIVE is not accepted here").
 */
export const MAX_FIELD_CONSTRAINT_CHARS = 280;
/** A sentence that says what is required or refused. */
const CONSTRAINT_WORDS =
  /\b(mandatory|required|must|not accepted|not allowed|rejected|refused|forbidden)\b/i;
/** An error code, which only a rejection names. */
const ERROR_CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/;
/** Says a field is needed, not that it is not. */
const REQUIREMENT = /\b(mandatory|required)\b/i;
/**
 * Most values a named enum may have and still be written out where it is used.
 * Past it the enum is referenced by name, like an object: a regime key or an
 * exemption reason has a score of values, and each call site repeating them
 * would outweigh the one call that reads them once.
 */
export const MAX_INLINE_ENUM_VALUES = 12;
/** Guard against a chain of scalar references that loops; the contract has none. */
const MAX_INLINE_DEPTH = 8;

const SCHEMA_REF_PREFIX = '#/components/schemas/';
const INDENT = '  ';

/** What rendering produced, and the named schemas it referenced without expanding. */
export interface Declaration {
  text: string;
  references: string[];
}

/** Collects the named schemas a declaration points to, in order of first use. */
class References {
  private readonly names = new Set<string>();
  add(name: string): void {
    this.names.add(name);
  }
  list(): string[] {
    return [...this.names];
  }
}

/** Every schema the contract names, sorted. */
export function schemaNames(doc: SpecNode): string[] {
  return Object.keys(componentSchemas(doc)).sort();
}

function componentSchemas(doc: SpecNode): Record<string, unknown> {
  const components = isRecord(doc.components) ? doc.components : {};
  return isRecord(components.schemas) ? components.schemas : {};
}

/** The schema a `#/components/schemas/X` reference names, or `undefined`. */
function refName(node: SpecNode): string | undefined {
  const ref = node.$ref;
  return typeof ref === 'string' && ref.startsWith(SCHEMA_REF_PREFIX)
    ? ref.slice(SCHEMA_REF_PREFIX.length)
    : undefined;
}

function schemaNamed(doc: SpecNode, name: string): SpecNode | undefined {
  const node = componentSchemas(doc)[name];
  return isRecord(node) ? node : undefined;
}

/** Whether a node says anything about the shape, as opposed to only annotating it. */
function isShape(node: unknown): node is SpecNode {
  if (!isRecord(node)) return false;
  return ['$ref', 'type', 'properties', 'items', 'enum', 'allOf', 'oneOf', 'anyOf'].some((key) =>
    Object.hasOwn(node, key),
  );
}

function enumValues(node: SpecNode): unknown[] | undefined {
  return Array.isArray(node.enum) ? node.enum : undefined;
}

/**
 * A named schema that is written out where it is used: a scalar, or an enum
 * short enough that its values read faster than its name.
 */
function isInlinable(node: SpecNode): boolean {
  if (node.properties || node.allOf || node.oneOf || node.anyOf || node.items) return false;
  if (node.type === 'object' || node.type === 'array') return false;
  const values = enumValues(node);
  return values === undefined || values.length <= MAX_INLINE_ENUM_VALUES;
}

/** A description on one line, without Markdown emphasis. */
function flatten(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** Abbreviations whose full stop ends no sentence ("e.g.", "art. 78", "arts. 6"). */
const ABBREVIATION = /\b(e\.g|i\.e|arts?|etc|vs|approx|No)$/i;

/**
 * The sentences of a description, in order. A full stop ends one unless it
 * closes an {@link ABBREVIATION}; a colon that opens a list does too, and the
 * list is dropped with it.
 */
function sentences(text: string): string[] {
  const flat = flatten(text);
  const out: string[] = [];
  let start = 0;
  for (const match of flat.matchAll(/[.!?](?=\s|$)|:(?=\s+[-*]\s)/g)) {
    if (ABBREVIATION.test(flat.slice(0, match.index))) continue;
    out.push(flat.slice(start, match.index + 1).trim());
    if (match[0] === ':') return out;
    start = match.index + 1;
  }
  const rest = flat.slice(start).trim();
  return rest ? [...out, rest] : out;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The first sentence of a description, on one line, without Markdown emphasis. */
export function firstSentence(text: unknown, max = MAX_FIELD_DESCRIPTION_CHARS): string {
  if (typeof text !== 'string') return '';
  return cut(sentences(text)[0] ?? '', max);
}

/**
 * Where a sentence may be cut and still say something true: after a semicolon
 * or a colon, before a dash, or before a clause joined by "and", "but" or
 * "which". Never at a bare comma, which may sit inside a list ("one of `a`,
 * `b` or `c`") whose first item alone would say the opposite.
 */
const CLAUSE_BOUNDARY = /(?<=[;:])\s|\s(?=—\s)|(?<=,)\s(?=(?:and|but|which)\s)/;

/**
 * The longest run of a sentence's leading clauses that fits in `room`, closed
 * with a full stop, or `undefined` when not even the first clause does.
 */
function leadingClauses(sentence: string, room: number): string | undefined {
  const clauses = sentence.split(CLAUSE_BOUNDARY);
  let best: string | undefined;
  for (let n = 1; n <= clauses.length; n++) {
    const text = clauses
      .slice(0, n)
      .join(' ')
      .replace(/[\s,;:.—]*$/, '.');
    if (text.length > room) break;
    best = text;
  }
  return best;
}

/**
 * What a field's comment says: its first sentence, then every later sentence
 * that states a requirement or a rejection, in order, within
 * {@link MAX_FIELD_CONSTRAINT_CHARS}. A constraint too long to fit keeps its
 * leading clauses, which is where the rule and the error code usually are.
 */
export function fieldDescription(text: unknown): string {
  if (typeof text !== 'string') return '';
  const [first = '', ...rest] = sentences(text);
  let out = cut(first, MAX_FIELD_DESCRIPTION_CHARS);
  for (const sentence of rest) {
    if (!CONSTRAINT_WORDS.test(sentence) && !ERROR_CODE.test(sentence)) continue;
    const room = MAX_FIELD_CONSTRAINT_CHARS - out.length - 1;
    const kept = sentence.length <= room ? sentence : leadingClauses(sentence, room);
    // One that does not fit is skipped, not the end: a shorter one after it may still.
    if (!kept) continue;
    out = `${out} ${kept}`;
  }
  return out;
}

/** Format, integer-ness, default and deprecation: what a type annotation cannot say. */
function hints(node: SpecNode): string[] {
  const out: string[] = [];
  if (node.type === 'integer') out.push('integer');
  if (typeof node.format === 'string') out.push(node.format);
  if (node.default !== undefined && !isRecord(node.default)) {
    out.push(`default ${JSON.stringify(node.default)}`);
  }
  if (node.deprecated === true) out.push('deprecated');
  if (node.readOnly === true) out.push('read-only');
  return out;
}

/** Hints of a node and of the parts of an `allOf` that only annotate it. */
function allHints(node: SpecNode): string[] {
  const own = hints(node);
  if (!Array.isArray(node.allOf)) return own;
  const nested = node.allOf.filter(isRecord).flatMap((part) => (isShape(part) ? [] : hints(part)));
  return [...new Set([...own, ...nested])];
}

/**
 * The trailing `// …` of a field: its hints, then what its description says
 * (see {@link fieldDescription}). An optional field whose description says it
 * is mandatory or required in some case is marked `conditionally required`: the
 * schema cannot say it, and the agent must not read `?` as "never needed".
 */
function fieldComment(doc: SpecNode, node: SpecNode, optional = false): string {
  let description = fieldDescription(node.description);
  if (!description) {
    // A bare reference carries no description of its own; the schema it names does.
    const target = shapeRef(node);
    const named = target ? schemaNamed(doc, target) : undefined;
    description = firstSentence(named?.description);
  }
  const conditional = optional && REQUIREMENT.test(description) ? ['conditionally required'] : [];
  const annotations = [...conditional, ...allHints(node)].join(', ');
  const parts = [annotations, description].filter(Boolean);
  return parts.length === 0 ? '' : ` // ${parts.join(' — ')}`;
}

/** The schema a field points to: its own `$ref`, or the one `allOf` wrapper around it. */
function shapeRef(node: SpecNode): string | undefined {
  const own = refName(node);
  if (own) return own;
  if (!Array.isArray(node.allOf)) return undefined;
  const shapes = node.allOf.filter(isShape);
  return shapes.length === 1 ? refName(shapes[0]!) : undefined;
}

function scalar(node: SpecNode): string {
  switch (node.type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'string':
    case 'boolean':
      return node.type;
    default:
      return 'unknown';
  }
}

/** Wrap a type in `[]`, or in `Array<…>` when it is a union, an intersection or a block. */
function arrayOf(item: string): string {
  return /[\s|&{]/.test(item) ? `Array<${item}>` : `${item}[]`;
}

/**
 * The type expression of a node, indented for the block it sits in. Inline
 * objects are written as blocks; named objects as their name.
 */
function typeOf(doc: SpecNode, node: unknown, refs: References, indent: string, depth = 0): string {
  if (!isRecord(node) || depth > MAX_INLINE_DEPTH) return 'unknown';
  const nullable = node.nullable === true ? ' | null' : '';

  const name = refName(node);
  if (name !== undefined) {
    const target = schemaNamed(doc, name);
    if (target && isInlinable(target)) {
      const inlined = typeOf(doc, target, refs, indent, depth + 1);
      return inlined.endsWith(' | null') ? inlined : inlined + nullable;
    }
    refs.add(name);
    return name + nullable;
  }

  for (const [keyword, joiner] of [
    ['allOf', ' & '],
    ['oneOf', ' | '],
    ['anyOf', ' | '],
  ] as const) {
    const parts = node[keyword];
    if (!Array.isArray(parts)) continue;
    const shapes = parts.filter(isShape).map((p) => typeOf(doc, p, refs, indent, depth + 1));
    if (shapes.length === 0) continue;
    const joined = shapes.length === 1 ? shapes[0]! : shapes.join(joiner);
    return joined + nullable;
  }

  const values = enumValues(node);
  if (values) return values.map((v) => JSON.stringify(v)).join(' | ') + nullable;

  if (node.type === 'array')
    return arrayOf(typeOf(doc, node.items, refs, indent, depth)) + nullable;

  if (node.type === 'object' || isRecord(node.properties)) {
    if (isRecord(node.properties)) return objectBlock(doc, node, refs, indent) + nullable;
    const extra = node.additionalProperties;
    const valueType = isRecord(extra) ? typeOf(doc, extra, refs, indent, depth) : 'unknown';
    return `Record<string, ${valueType}>${nullable}`;
  }
  return scalar(node) + nullable;
}

/** `{ … }` with one line per property, in contract order. */
function objectBlock(doc: SpecNode, node: SpecNode, refs: References, indent: string): string {
  const properties = isRecord(node.properties) ? node.properties : {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const inner = indent + INDENT;
  const lines = Object.entries(properties).map(([key, value]) => {
    const field = isRecord(value) ? value : {};
    const type = typeOf(doc, field, refs, inner);
    const optional = required.has(key) ? '' : '?';
    return `${inner}${key}${optional}: ${type};${fieldComment(doc, field, optional === '?')}`;
  });
  return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n${indent}}`;
}

/** The `// …` line above a declaration: the first sentence of the schema's description. */
function heading(description: unknown): string {
  const sentence = firstSentence(description);
  return sentence ? `// ${sentence}\n` : '';
}

/**
 * One named schema as a declaration: an `interface` for an object (with
 * `extends` for an `allOf` over named bases), a `type` alias otherwise. An enum
 * is written out whole here, however long, since this is where it is read.
 */
export function declareSchema(doc: SpecNode, name: string): Declaration | undefined {
  const node = schemaNamed(doc, name);
  if (!node) return undefined;
  const refs = new References();
  return {
    text: heading(node.description) + declaration(doc, name, node, refs),
    references: refs.list(),
  };
}

/** `interface Name …` or `type Name = …;` for a node, under the name given. */
function declaration(doc: SpecNode, name: string, node: SpecNode, refs: References): string {
  const parts = Array.isArray(node.allOf) ? node.allOf.filter(isShape) : [];
  const bases = parts.map(refName);
  const objects = parts.filter((p) => refName(p) === undefined && isRecord(p.properties));
  const isInheritance =
    parts.length > 0 && parts.every((p, i) => bases[i] !== undefined || objects.includes(p));

  if (isRecord(node.properties) || (isInheritance && objects.length > 0)) {
    const merged = mergeObjects([node, ...objects]);
    const names = bases.filter((b): b is string => b !== undefined);
    names.forEach((b) => refs.add(b));
    const extendsClause = names.length > 0 ? ` extends ${names.join(', ')}` : '';
    return `interface ${name}${extendsClause} ${objectBlock(doc, merged, refs, '')}`;
  }
  // The description already opens the declaration; the comment keeps only the hints.
  const hintsOnly = fieldComment(doc, { ...node, description: undefined });
  return `type ${name} = ${typeOf(doc, node, refs, '')};${hintsOnly}`;
}

/** The properties and required lists of several object nodes, as one. */
function mergeObjects(nodes: SpecNode[]): SpecNode {
  const properties: Record<string, unknown> = {};
  const required: unknown[] = [];
  for (const node of nodes) {
    if (isRecord(node.properties)) Object.assign(properties, node.properties);
    if (Array.isArray(node.required)) required.push(...node.required);
  }
  return { type: 'object', properties, required };
}

/** `CreateCompanyInvoice` from `createCompanyInvoice`: the name of an operation's own types. */
function pascal(operationId: string): string {
  return operationId.charAt(0).toUpperCase() + operationId.slice(1);
}

/**
 * The schema an operation's success response carries under `data`, the part a
 * caller reads. `undefined` for a response without a JSON body.
 */
function responseData(doc: SpecNode, op: OperationSpec): unknown {
  const pathItem = isRecord(doc.paths) ? doc.paths[op.path] : undefined;
  const operation = isRecord(pathItem) ? pathItem[op.method.toLowerCase()] : undefined;
  const responses = isRecord(operation) && isRecord(operation.responses) ? operation.responses : {};
  const success = Object.keys(responses).find((code) => /^2\d\d$/.test(code));
  const response = success ? resolveRef(doc, responses[success]) : undefined;
  const content = isRecord(response?.content) ? response.content : {};
  const media = content['application/json'];
  const schema = isRecord(media) ? resolveRef(doc, media.schema) : undefined;
  if (!schema) return undefined;
  // The envelope is `allOf: [SuccessResponse, { properties: { data } }]`.
  const parts = Array.isArray(schema.allOf) ? schema.allOf.filter(isRecord) : [schema];
  const withData = parts.find((p) => isRecord(p.properties) && isRecord(p.properties.data));
  return withData && isRecord(withData.properties) ? withData.properties.data : undefined;
}

/**
 * What a call to an operation sends and gets back: its query parameters as an
 * interface, its body (a named schema is declared in full, since that is what
 * was asked for), and the type it returns.
 */
export function declareOperation(doc: SpecNode, op: OperationSpec, toolName: string): Declaration {
  const refs = new References();
  const blocks: string[] = [];
  const data = responseData(doc, op);
  let returns = data === undefined ? undefined : typeOf(doc, data, refs, '');
  if (returns?.includes('\n')) {
    // An inline response object gets a name of its own rather than a block in the header.
    blocks.push(`type ${pascal(op.operationId)}Data = ${returns};`);
    returns = `${pascal(op.operationId)}Data`;
  }
  blocks.unshift(
    `// ${toolName}: ${op.method} ${op.path}${returns ? ` → returns ${returns}` : ''}`,
  );

  if (op.queryParams.length > 0) {
    const properties = Object.fromEntries(
      op.queryParams.map((p) => [p.name, { ...p.schema, description: p.description }]),
    );
    const required = op.queryParams.filter((p) => p.required).map((p) => p.name);
    const query = { type: 'object', properties, required };
    blocks.push(`interface ${pascal(op.operationId)}Query ${objectBlock(doc, query, refs, '')}`);
  }

  const body = op.requestBody?.schema;
  const bodyName = body ? refName(body) : undefined;
  if (bodyName) {
    const named = declareSchema(doc, bodyName);
    if (named) {
      blocks.push(`// body: ${bodyName}\n${named.text}`);
      named.references.forEach((name) => refs.add(name));
    }
  } else if (body) {
    blocks.push(declaration(doc, `${pascal(op.operationId)}Body`, body, refs));
  }
  if (!op.queryParams.length && !body) blocks.push('// no query parameters and no body');
  return { text: blocks.join('\n'), references: refs.list() };
}
