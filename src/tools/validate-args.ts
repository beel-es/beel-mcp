import Ajv, { type ValidateFunction } from 'ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Validates tool arguments against the tool's own `inputSchema` before anything
 * touches the network.
 *
 * The MCP SDK does NOT do this: `inputSchema` is advertised to the model as a
 * contract, and then whatever arrives is passed straight through. Since these
 * schemas are derived from the OpenAPI operations, validating against them is
 * free precision — a missing `company_id` or a `lines` object where an array
 * belongs is caught here with a message naming the field, instead of surfacing as
 * an opaque 400 several layers away.
 *
 * `strict: false` is required: OpenAPI schemas carry annotation keywords (
 * `example`, `nullable`, `deprecated`) that are not JSON Schema validation
 * keywords. `tests/validate-args.test.ts` compiles every derived schema, so an
 * incompatible keyword fails CI rather than a user's call.
 */
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  // Formats are annotations here (uuid, date-time); the API is the authority on
  // them. Validating format locally would reject values the API accepts.
  validateFormats: false,
});

const compiled = new WeakMap<Tool, ValidateFunction>();

export class ArgumentError extends Error {
  constructor(
    readonly toolName: string,
    readonly issues: string[],
  ) {
    super(
      [`Invalid arguments for ${toolName}:`, ...issues.map((i) => `- ${i}`)].join('\n'),
    );
    this.name = 'ArgumentError';
  }
}

function validatorFor(tool: Tool): ValidateFunction | null {
  const cached = compiled.get(tool);
  if (cached) return cached;
  try {
    const validate = ajv.compile(tool.inputSchema);
    compiled.set(tool, validate);
    return validate;
  } catch {
    // An uncompilable schema must never block a call: the API remains the
    // authority. CI catches these, production degrades to no local validation.
    return null;
  }
}

/** Human-readable issues, ordered as Ajv reports them. Empty when valid. */
export function findArgumentIssues(tool: Tool, args: unknown): string[] {
  const validate = validatorFor(tool);
  if (!validate) return [];
  if (validate(args)) return [];
  return (validate.errors ?? []).map((err) => {
    const where = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'arguments';
    return `${where} ${err.message ?? 'is invalid'}`;
  });
}

/** Throw when the arguments do not satisfy the tool's advertised contract. */
export function assertValidArguments(tool: Tool, args: unknown): void {
  const issues = findArgumentIssues(tool, args);
  if (issues.length > 0) throw new ArgumentError(tool.name, issues);
}
