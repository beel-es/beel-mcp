import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  declareOperation,
  declareSchema,
  schemaNames,
  type Declaration,
} from '../spec/declarations.js';
import { loadSpec } from '../spec/load.js';
import type { OperationSpec } from '../spec/manifest.js';
import { closestMatches } from '../shared/similar.js';
import { routeNamer } from '../spec/routes.js';
import { buildApiTools } from './api-tools.js';
import { ArgumentError, assertValidArguments } from './validate-args.js';

/**
 * The contract's schemas as a tool: what fields a body takes, and what a call
 * returns, read from the OpenAPI document this server already bundles. It
 * answers "what does CreateInvoiceRequest take" in one short call, where an SDK's
 * type file or the reference page answers it in tens of KB. Spends no API quota
 * and never leaves the process.
 */

export const SCHEMA_GET = 'beel_schema_get';

/** Most names one call declares. */
export const MAX_SCHEMAS = 10;
/** Most close matches offered for a name that does not exist. */
export const MAX_SUGGESTIONS = 5;
/** Most schema names a `query` lists. */
export const MAX_LISTED_NAMES = 80;
/**
 * Ceiling on one answer. The largest schema is a few KB; ten of them can pass
 * this, and the ones left out are named so the next call asks for them.
 */
export const MAX_SCHEMA_OUTPUT_CHARS = 30_000;

export const schemaTools: Tool[] = [
  {
    name: SCHEMA_GET,
    description:
      'Get the fields of API request and response schemas as compact TypeScript-like ' +
      'declarations from the OpenAPI contract: type, required or optional, enum values and a ' +
      'one-line description per field. Pass schema names (e.g. "CreateInvoiceRequest"), or a ' +
      'tool name or operationId (e.g. "beel_create_invoice") for its query, body and return ' +
      'type. Schemas a declaration references are named, not expanded; query lists names.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A schema name, a tool name or an operationId.',
          minLength: 1,
        },
        names: {
          type: 'array',
          description: `Several in one call (at most ${MAX_SCHEMAS}), e.g. ["Recipient", "TaxInfo"].`,
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: MAX_SCHEMAS,
        },
        query: {
          type: 'string',
          description: 'Lists the schema names that contain it, ignoring case, e.g. "invoice".',
          minLength: 1,
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Get API schema', readOnlyHint: true, openWorldHint: false },
  },
];

const byName = new Map(schemaTools.map((tool) => [tool.name, tool]));

export function isSchemaTool(name: string): boolean {
  return byName.has(name);
}

/** Raised for a lookup the contract cannot answer; the message says what exists. */
export class SchemaQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaQueryError';
  }
}

interface OperationEntry {
  op: OperationSpec;
  toolName: string;
}

let operations: Map<string, OperationEntry> | undefined;

/** Operations addressable by the tool name an agent sees or by their operationId; built once. */
function operationsByName(): Map<string, OperationEntry> {
  if (operations) return operations;
  operations = new Map();
  for (const { tool, operation } of buildApiTools().tools) {
    const entry = { op: operation, toolName: tool.name };
    operations.set(tool.name, entry);
    operations.set(operation.operationId, entry);
  }
  return operations;
}

/** What one name resolves to: its declaration, the schema it declares if any, and a key naming it. */
interface Resolved {
  declaration: Declaration;
  schema?: string;
  /** The schema name or the tool name, whatever spelling was asked for. */
  key: string;
}

let nameRoutes: ((text: string) => string) | undefined;

/**
 * A declaration with the routes its descriptions quote named as the tools that
 * call them, as in the tool definitions (see `src/spec/routes.ts`).
 */
function withToolNames(declaration: Declaration): Declaration {
  nameRoutes ??= routeNamer(
    buildApiTools().tools.map(({ tool, operation }) => ({
      name: tool.name,
      method: operation.method,
      path: operation.path,
    })),
  );
  return { ...declaration, text: nameRoutes(declaration.text) };
}

/** Exact names first, then the same names ignoring case. */
function resolve(wanted: string, schemas: string[]): Resolved | undefined {
  const doc = loadSpec();
  const byOperation = operationsByName();
  const lower = wanted.toLowerCase();
  const schema =
    schemas.find((n) => n === wanted) ?? schemas.find((n) => n.toLowerCase() === lower);
  if (schema) {
    return { declaration: withToolNames(declareSchema(doc, schema)!), schema, key: schema };
  }
  const operation =
    byOperation.get(wanted) ?? [...byOperation].find(([key]) => key.toLowerCase() === lower)?.[1];
  if (operation) {
    return {
      declaration: withToolNames(declareOperation(doc, operation.op, operation.toolName)),
      key: operation.toolName,
    };
  }
  return undefined;
}

function notFound(wanted: string, schemas: string[]): string {
  const candidates = [...schemas, ...buildApiTools().tools.map((t) => t.tool.name)];
  const close = closestMatches(wanted, candidates, MAX_SUGGESTIONS);
  return (
    `No schema, tool or operationId "${wanted}".` +
    (close.length > 0 ? ` Close matches: ${close.join(', ')}.` : '') +
    ' List schema names with query.'
  );
}

/** Schema names containing `query`, bounded, with a way to see the rest. */
function listNames(query: string, schemas: string[]): string {
  const lower = query.toLowerCase();
  const matches = schemas.filter((n) => n.toLowerCase().includes(lower));
  if (matches.length === 0) {
    const close = closestMatches(query, schemas, MAX_SUGGESTIONS);
    return (
      `No schema name contains "${query}".` +
      (close.length > 0 ? ` Close matches: ${close.join(', ')}.` : '')
    );
  }
  const shown = matches.slice(0, MAX_LISTED_NAMES);
  const lines = [`${matches.length} schema names contain "${query}": ${shown.join(', ')}`];
  if (matches.length > shown.length) {
    lines.push(`Truncated: ${matches.length - shown.length} more not shown. Use a longer query.`);
  }
  lines.push('A tool name or operationId is accepted too, for its query, body and return type.');
  return lines.join('\n');
}

/** Every name asked for, `name` first and then `names`, each once. */
function namesArgument(args: Record<string, unknown>): string[] {
  const asked = [args.name, ...(Array.isArray(args.names) ? args.names : [])];
  const names = asked
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Declare every name asked for, in the order asked, within
 * {@link MAX_SCHEMA_OUTPUT_CHARS}. An unknown name is answered with close
 * matches without failing the others; the schemas the declarations reference
 * but do not expand are named at the end, for one follow-up call. `found` is
 * false when no name resolved.
 */
export function declareAll(
  wanted: string[],
  schemas: string[],
  limit = MAX_SCHEMA_OUTPUT_CHARS,
): { text: string; found: boolean } {
  const blocks: string[] = [];
  const unknown: string[] = [];
  const declared = new Set<string>();
  const seen = new Set<string>();
  const referenced: string[] = [];
  const skipped: string[] = [];
  let length = 0;

  for (const name of wanted) {
    const resolved = resolve(name, schemas);
    if (!resolved) {
      unknown.push(notFound(name, schemas));
      continue;
    }
    // Two spellings of one schema, or a tool and its operationId, declare it once.
    if (seen.has(resolved.key)) continue;
    seen.add(resolved.key);
    const { text, references } = resolved.declaration;
    if (length > 0 && length + text.length > limit) {
      skipped.push(name);
      continue;
    }
    blocks.push(text);
    length += text.length;
    if (resolved.schema) declared.add(resolved.schema);
    for (const ref of references) if (!referenced.includes(ref)) referenced.push(ref);
  }

  if (blocks.length === 0) return { text: unknown.join('\n'), found: false };
  const notShown = referenced.filter((ref) => !declared.has(ref));
  const notes = [
    ...unknown,
    ...(skipped.length > 0
      ? [`Not shown, over the output limit: ${skipped.join(', ')}. Ask for them in another call.`]
      : []),
    ...(notShown.length > 0
      ? [`Referenced, not shown: ${notShown.join(', ')}. Read them with names.`]
      : []),
  ];
  const text = [blocks.join('\n\n'), ...(notes.length > 0 ? ['', ...notes] : [])].join('\n');
  return { text, found: true };
}

export async function executeSchemaTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`Unknown schema tool: ${name}`);
  assertValidArguments(tool, args);

  const wanted = namesArgument(args);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (wanted.length === 0 && !query) {
    throw new ArgumentError(SCHEMA_GET, [
      'pass name or names (a schema such as "CreateInvoiceRequest", or a tool name such as ' +
        '"beel_create_invoice"), or query to list schema names.',
    ]);
  }
  const schemas = schemaNames(loadSpec());
  const parts: string[] = [];
  if (wanted.length > 0) {
    const { text, found } = declareAll(wanted, schemas);
    // Nothing to show and nothing listed: an error, so the caller does not read it as a schema.
    if (!found && !query) throw new SchemaQueryError(text);
    parts.push(text);
  }
  if (query) parts.push(listNames(query, schemas));
  return parts.join('\n\n');
}
