import type { SpecNode } from './load.js';
import type { OperationSpec } from './manifest.js';
import { IDEMPOTENCY_KEY_PARAM } from './manifest.js';
import { resolvePointer } from './refs.js';

/** A minimal JSON Schema object — what MCP tools expose as `inputSchema`. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, object>;
  required?: string[];
  $defs?: Record<string, unknown>;
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** OpenAPI 3.0 keywords we drop when projecting a schema to JSON Schema for an LLM. */
const DROP_KEYS = new Set([
  'xml',
  'externalDocs',
  'discriminator',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/**
 * OpenAPI 3.0 spells exclusive bounds as a boolean flag modifying `minimum` /
 * `maximum`; JSON Schema (draft 6 onwards, which is what MCP clients validate
 * against) spells them as the bound itself. Left untranslated, the advertised
 * `inputSchema` is not valid JSON Schema at all — strict validators reject the
 * whole tool definition rather than the offending value.
 */
function normaliseExclusiveBounds(out: Record<string, unknown>): void {
  for (const [flag, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    const value = out[flag];
    if (typeof value !== 'boolean') continue;
    if (value && typeof out[bound] === 'number') {
      out[flag] = out[bound];
      delete out[bound];
    } else {
      delete out[flag];
    }
  }
}

function schemaRefName(ref: string): string | null {
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  return match ? match[1]! : null;
}

/**
 * Projects OpenAPI schemas to JSON Schema, preserving `$ref`s as local `#/$defs`
 * entries. This keeps each tool's inputSchema compact (shared schemas appear
 * once) and recursion-safe (a self-referential schema becomes a `$ref` back into
 * `$defs` rather than expanding forever).
 */
class SchemaProjector {
  readonly defs: Record<string, unknown> = {};
  private readonly inProgress = new Set<string>();

  constructor(private readonly doc: SpecNode) {}

  project(node: unknown): unknown {
    return this.clone(node);
  }

  private clone(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((item) => this.clone(item));
    if (!node || typeof node !== 'object') return node;

    const src = node as SpecNode;
    const ref = src.$ref;
    if (typeof ref === 'string') {
      const name = schemaRefName(ref);
      if (name) {
        this.ensureDef(name);
        return { $ref: `#/$defs/${name}` };
      }
      // Non-schema pointer (parameter, etc.): resolve and inline once.
      const target = resolvePointer(this.doc, ref);
      return target ? this.clone(target) : {};
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if (DROP_KEYS.has(key) || key === 'nullable') continue;
      out[key] = this.clone(value);
    }
    if (src.nullable === true && typeof src.type === 'string') {
      out.type = [src.type, 'null'];
    }
    normaliseExclusiveBounds(out);
    return out;
  }

  private ensureDef(name: string): void {
    if (name in this.defs || this.inProgress.has(name)) return;
    this.inProgress.add(name);
    const target = resolvePointer(this.doc, `#/components/schemas/${name}`);
    this.defs[name] = target ? this.clone(target) : {};
    this.inProgress.delete(name);
  }
}

/**
 * Build the MCP `inputSchema` for an operation: path params and query params
 * become top-level properties; a JSON request body is nested under `body` so its
 * full structure (line items, enums, regime keys…) reaches the model intact.
 */
export function buildInputSchema(op: OperationSpec, doc: SpecNode): JsonSchema {
  const projector = new SchemaProjector(doc);
  const properties: Record<string, object> = {};
  const required: string[] = [];

  const withDescription = (schema: unknown, description?: string): object => {
    const obj = (schema && typeof schema === 'object' ? schema : {}) as Record<string, unknown>;
    if (description && obj.description === undefined) obj.description = description;
    return obj;
  };

  for (const p of op.pathParams) {
    properties[p.name] = withDescription(projector.project(p.schema), p.description);
    required.push(p.name);
  }
  for (const p of op.queryParams) {
    properties[p.name] = withDescription(projector.project(p.schema), p.description);
    if (p.required) required.push(p.name);
  }
  if (op.requestBody && op.requestBody.contentType.includes('json')) {
    properties.body = withDescription(projector.project(op.requestBody.schema));
    if (op.requestBody.required) required.push('body');
  }
  // Escotilla de idempotencia. Sin ella, la clave sale SIEMPRE de un hash del
  // cuerpo, así que dos operaciones legítimamente idénticas dentro de 24 h —dos
  // facturas iguales al mismo cliente el mismo día— colapsan en una: la API
  // devuelve el resultado de la primera y el agente cree que creó la segunda.
  // Un hash no puede distinguir un reintento de una repetición querida; solo
  // quien llama lo sabe. Opcional, para que el hash siga cubriendo el reintento
  // ciego, que es el caso que sí puede resolver.
  if (op.method === 'POST' && (op.headerParams ?? []).some((p) => p.name === IDEMPOTENCY_KEY_PARAM)) {
    properties.idempotency_key = {
      type: 'string',
      pattern: '^[a-zA-Z0-9_-]+$',
      maxLength: 255,
      description:
        'Optional idempotency key for this operation. Omit it and one is derived from the ' +
        'request itself, which makes a blind retry safe but also collapses a SECOND, ' +
        'deliberately identical operation into the first for 24 hours. Set it — to an order ' +
        'id, or anything unique per intended operation — whenever you mean to create ' +
        'something that may look identical to what you just created.',
    };
  }

  const out: JsonSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  if (Object.keys(projector.defs).length > 0) out.$defs = projector.defs;
  return out;
}
