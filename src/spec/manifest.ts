import { loadSpec, type SpecNode } from './load.js';
import { pathParams as extractPathParams } from './derive.js';
import { resolveRef } from './refs.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Non-JSON success content types that make an operation a binary download. */
const BINARY_CONTENT_TYPES = [
  'application/pdf',
  'application/zip',
  'application/octet-stream',
  'application/vnd.openxmlformats', // xlsx
  'application/vnd.ms-excel',
  'text/csv',
];

export interface ParamSpec {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description?: string;
  schema: SpecNode;
}

export interface RequestBodySpec {
  required: boolean;
  contentType: string;
  schema?: SpecNode;
}

export interface OperationSpec {
  operationId: string;
  method: Uppercase<HttpMethod>;
  path: string;
  /** Every tag the operation carries, in contract order. Never empty. */
  tags: string[];
  summary: string;
  description: string;
  pathParams: ParamSpec[];
  queryParams: ParamSpec[];
  headerParams: ParamSpec[];
  requestBody?: RequestBodySpec;
  /** Success (2xx) response content types. */
  successContentTypes: string[];
  /** The success response is a non-JSON binary (pdf/zip/xlsx/csv). */
  binaryResponse: boolean;
  /** Marked `deprecated: true` in the spec (legacy pre-company surface). */
  deprecated: boolean;
  /** OAuth2 scopes this operation requires (from its `x-required-scopes`). */
  scopes: string[];
  /** Names of the security schemes that authenticate this operation. */
  securitySchemes: string[];
  /**
   * The contract's own verdict on whether the operation can be undone, from
   * `x-irreversible` or `x-agent-hints.irreversible`. `undefined` means the
   * contract does not say, which is the case for every operation today.
   */
  irreversible: boolean | undefined;
}

/** Operations with no tag are grouped under `Other`, so `tags` is never empty. */
function asTags(value: unknown): string[] {
  const tags = Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
  return tags.length > 0 ? tags : ['Other'];
}

function asNode(value: unknown): SpecNode | undefined {
  return value && typeof value === 'object' ? (value as SpecNode) : undefined;
}

function buildParams(doc: SpecNode, raw: unknown[]): ParamSpec[] {
  const params: ParamSpec[] = [];
  for (const entry of raw) {
    // A parameter entry may itself be a $ref (e.g. shared page/limit params).
    const node = resolveRef(doc, entry) ?? asNode(entry);
    if (!node) continue;
    const where = node.in as ParamSpec['in'] | undefined;
    const name = node.name as string | undefined;
    if (!where || !name || where === 'header') {
      // header params (idempotency, active-company) are handled by the http layer,
      // not surfaced as tool inputs — keep them out of the manifest's surfaced lists.
      if (where === 'header' && name) {
        params.push({
          name,
          in: 'header',
          required: Boolean(node.required),
          description: node.description as string | undefined,
          schema: asNode(node.schema) ?? {},
        });
      }
      continue;
    }
    params.push({
      name,
      in: where,
      required: Boolean(node.required),
      description: node.description as string | undefined,
      schema: asNode(node.schema) ?? {},
    });
  }
  return params;
}

function buildRequestBody(doc: SpecNode, operation: SpecNode): RequestBodySpec | undefined {
  const body = resolveRef(doc, operation.requestBody) ?? asNode(operation.requestBody);
  if (!body) return undefined;
  const content = asNode(body.content);
  if (!content) return undefined;
  // Prefer JSON; fall back to the first declared content type (e.g. multipart).
  const contentType =
    Object.keys(content).find((ct) => ct.includes('json')) ?? Object.keys(content)[0];
  if (!contentType) return undefined;
  const media = asNode(content[contentType]);
  return {
    required: Boolean(body.required),
    contentType,
    schema: asNode(media?.schema),
  };
}

function buildResponseInfo(
  doc: SpecNode,
  operation: SpecNode,
): {
  successContentTypes: string[];
  binaryResponse: boolean;
} {
  const responses = asNode(operation.responses) ?? {};
  const successCodes = Object.keys(responses).filter((code) => /^2\d\d$/.test(code));
  const contentTypes = new Set<string>();
  for (const code of successCodes) {
    const response = resolveRef(doc, responses[code]) ?? asNode(responses[code]);
    const content = asNode(response?.content);
    if (content) for (const ct of Object.keys(content)) contentTypes.add(ct);
  }
  const list = [...contentTypes];
  const binaryResponse =
    list.length > 0 && list.every((ct) => BINARY_CONTENT_TYPES.some((bin) => ct.startsWith(bin)));
  return { successContentTypes: list, binaryResponse };
}

/**
 * Scopes required by an operation.
 *
 * `x-required-scopes` is where the public contract declares them. The `security`
 * entries are read as well, for specs that still carry the scopes inside their
 * OAuth2 requirement: reading only one of the two yields an empty set against
 * the other, and a client that asks for no scopes gets a key that cannot work.
 */
function buildScopes(operation: SpecNode): string[] {
  const scopes = new Set<string>();

  const declared = operation['x-required-scopes'];
  if (Array.isArray(declared)) {
    for (const s of declared) if (typeof s === 'string') scopes.add(s);
  }

  const security = operation.security;
  if (Array.isArray(security)) {
    for (const requirement of security) {
      const node = asNode(requirement);
      if (!node) continue;
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const s of value) if (typeof s === 'string') scopes.add(s);
      }
    }
  }
  return [...scopes];
}

/**
 * The contract's own statement about reversibility, if it makes one. Read from
 * `x-irreversible` first, then from an `x-agent-hints` object, so an author can
 * settle the question the annotation heuristics otherwise have to guess at.
 */
function readIrreversible(operation: SpecNode): boolean | undefined {
  const direct = operation['x-irreversible'];
  if (typeof direct === 'boolean') return direct;
  const hints = asNode(operation['x-agent-hints']);
  const nested = hints?.irreversible;
  return typeof nested === 'boolean' ? nested : undefined;
}

/**
 * The security schemes that authenticate an operation. An operation without its
 * own `security` inherits the document-level requirement, which is what the
 * contract uses to state the default once.
 */
function buildSecuritySchemes(doc: SpecNode, operation: SpecNode): string[] {
  const requirements = Array.isArray(operation.security) ? operation.security : doc.security;
  if (!Array.isArray(requirements)) return [];
  const names = new Set<string>();
  for (const requirement of requirements) {
    const node = asNode(requirement);
    if (node) for (const name of Object.keys(node)) names.add(name);
  }
  return [...names];
}

/** Walk the spec's `paths` and produce one OperationSpec per operation with an operationId. */
export function buildManifest(doc: SpecNode): OperationSpec[] {
  const operations: OperationSpec[] = [];
  const paths = asNode(doc.paths) ?? {};

  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = asNode(rawItem);
    if (!pathItem) continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const operation = asNode(pathItem[method]);
      if (!operation || typeof operation.operationId !== 'string') continue;

      const ownParams = Array.isArray(operation.parameters) ? operation.parameters : [];
      const allParams = buildParams(doc, [...sharedParams, ...ownParams]);
      const declaredTags = operation.tags;
      const { successContentTypes, binaryResponse } = buildResponseInfo(doc, operation);

      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase() as Uppercase<HttpMethod>,
        path,
        tags: asTags(declaredTags),
        summary: String(operation.summary ?? `${method.toUpperCase()} ${path}`),
        description: String(operation.description ?? operation.summary ?? ''),
        pathParams: allParams.filter((p) => p.in === 'path'),
        queryParams: allParams.filter((p) => p.in === 'query'),
        headerParams: allParams.filter((p) => p.in === 'header'),
        requestBody: buildRequestBody(doc, operation),
        successContentTypes,
        binaryResponse,
        deprecated: operation.deprecated === true,
        scopes: buildScopes(operation),
        securitySchemes: buildSecuritySchemes(doc, operation),
        irreversible: readIrreversible(operation),
      });
    }
  }

  // Sanity: every path param in the template must be present as a param spec.
  for (const op of operations) {
    const declared = new Set(op.pathParams.map((p) => p.name));
    for (const tpl of extractPathParams(op.path)) {
      if (!declared.has(tpl)) {
        op.pathParams.push({ name: tpl, in: 'path', required: true, schema: { type: 'string' } });
      }
    }
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return operations;
}

/**
 * The manifest of the bundled contract, built once.
 *
 * Computed on first use rather than at import time: the Worker injects the spec
 * with `setSpecSource()` in a top-level statement, which runs only after every
 * import has been evaluated.
 */
let cachedManifest: OperationSpec[] | null = null;
export function specManifest(): OperationSpec[] {
  return (cachedManifest ??= buildManifest(loadSpec()));
}
