import type { SpecNode } from './load.js';
import type { OperationSpec } from './manifest.js';
import { BEEL_HEADER } from '../shared/defaults.js';
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

/**
 * OpenAPI 3.0 keywords dropped when projecting a schema to JSON Schema for an
 * LLM. Some carry no meaning for a validator (`xml`, `externalDocs`); the
 * examples are dropped for a different reason: every tool definition is sent on
 * every request, so a schema's bytes are taken from the same context the
 * conversation needs, and an example restates what the description already says.
 */
const DROP_KEYS = new Set([
  'xml',
  'externalDocs',
  'discriminator',
  'deprecated',
  'readOnly',
  'writeOnly',
  'example',
  'examples',
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

/** Keywords whose members each describe only part of the instance. */
const COMPOSITION_KEYS = new Set(['allOf', 'anyOf', 'oneOf']);

/**
 * Close an object schema to the properties it declares.
 *
 * An open schema lets an argument the model invented reach the API, which
 * answers 400 about a field the model believed in; closed, the client's own
 * validator says so before the call. Three things stop it being universal: the
 * contract's own `additionalProperties` wins where it makes one (a body that is
 * genuinely a bag of keys must stay one), a schema built by composition has its
 * properties elsewhere, and a member of a composition is only part of the
 * instance being described.
 */
function closeIfPlainObject(
  out: Record<string, unknown>,
  src: SpecNode,
  composed: boolean,
): Record<string, unknown> {
  if (composed || out.additionalProperties !== undefined) return out;
  if (Object.keys(src).some((key) => COMPOSITION_KEYS.has(key))) return out;
  if (out.type !== 'object' || !out.properties) return out;
  out.additionalProperties = false;
  return out;
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

  /**
   * `composed` marks a node reached as a member of an allOf/oneOf/anyOf. Such a
   * node describes only part of the instance — its siblings supply the rest — so
   * it must stay open, or the properties they contribute are rejected.
   */
  private clone(node: unknown, composed = false): unknown {
    if (Array.isArray(node)) return node.map((item) => this.clone(item, composed));
    if (!node || typeof node !== 'object') return node;

    const src = node as SpecNode;
    const ref = src.$ref;
    if (typeof ref === 'string') {
      const name = schemaRefName(ref);
      if (name) {
        this.ensureDef(name);
        const target = { $ref: `#/$defs/${name}` };
        // A `$ref` with a sibling keyword has no JSON Schema meaning, so the
        // OpenAPI 3.0 spelling `{$ref, nullable: true}` loses its null unless
        // the pair is rewritten as a branch.
        return src.nullable === true ? { anyOf: [target, { type: 'null' }] } : target;
      }
      // Non-schema pointer (parameter, etc.): resolve and inline once.
      const target = resolvePointer(this.doc, ref);
      return target ? this.clone(target) : {};
    }

    const out: Record<string, unknown> = {};
    const readOnlyNames = new Set<string>();
    for (const [key, value] of Object.entries(src)) {
      if (DROP_KEYS.has(key) || key === 'nullable') continue;
      if (key === 'properties') out[key] = this.cloneProperties(value, readOnlyNames);
      else out[key] = this.clone(value, COMPOSITION_KEYS.has(key));
    }
    if (readOnlyNames.size > 0 && Array.isArray(out.required)) {
      out.required = out.required.filter(
        (name) => typeof name === 'string' && !readOnlyNames.has(name),
      );
    }
    if (src.nullable === true) {
      // `type: [x, 'null']` only works where there is a single scalar type to
      // widen. A nullable $ref or allOf has none, so the null has to become a
      // branch of its own or it is simply lost.
      if (typeof src.type === 'string') out.type = [src.type, 'null'];
      else return { anyOf: [out, { type: 'null' }] };
    }
    normaliseExclusiveBounds(out);
    return closeIfPlainObject(out, src, composed);
  }

  /**
   * Project a `properties` map, dropping the readOnly members.
   *
   * A readOnly field is the server's answer, not the caller's input. Left in an
   * inputSchema it reads to a model as something it may set — and a request that
   * sets one is rejected. It is removed from `required` alongside, since a
   * required property that does not exist makes the schema unsatisfiable.
   */
  private cloneProperties(value: unknown, dropped: Set<string>): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return this.clone(value);
    const projected: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(value as SpecNode)) {
      if (schema && typeof schema === 'object' && (schema as SpecNode).readOnly === true) {
        dropped.add(name);
        continue;
      }
      projected[name] = this.clone(schema);
    }
    return projected;
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
  // The caller's escape hatch from the derived idempotency key. Without one, the
  // key is a hash of the request, so two deliberately identical operations
  // within the idempotency window — the same invoice to the same customer on the
  // same day — collapse into one: the API returns the first result and the agent
  // believes it created the second. A hash cannot tell a retry from an intended
  // repetition; only the caller knows which it is. Optional, so the hash still
  // covers the blind retry, which is the case it can decide on its own.
  if (
    op.method === 'POST' &&
    (op.headerParams ?? []).some((p) => p.name === BEEL_HEADER.idempotencyKey)
  ) {
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

  // Closed at the top level unconditionally: every property here is one this
  // function put there, so anything else is an argument the model invented. An
  // open schema lets it through to the API, which answers 400 about a field the
  // model believed in; closed, the client's own validator says so first.
  const out: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  if (Object.keys(projector.defs).length > 0) out.$defs = projector.defs;
  return out;
}
