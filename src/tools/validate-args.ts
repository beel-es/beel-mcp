import { Validator, type OutputUnit } from '@cfworker/json-schema';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Validates tool arguments — and a tool's own structured output — against the
 * schemas the server advertises.
 *
 * The MCP SDK does NOT do this: `inputSchema` is announced to the model as a
 * contract, and then whatever arrives is passed straight through. Since these
 * schemas are derived from the OpenAPI operations, validating against them is
 * free precision: a missing `company_id`, or a `lines` object where an array
 * belongs, is caught here with a message naming the field instead of surfacing
 * as an opaque 400 several layers away.
 *
 * The validator interprets the schema rather than compiling it to source. That
 * is a hard requirement, not a preference: the remote transport runs on
 * Cloudflare Workers, where `new Function` is unavailable, so a code-generating
 * validator throws at build time and every remote call would go out unchecked.
 * `tests/validate-args.test.ts` asserts that no `Function` is constructed.
 *
 * Draft 2019-09 is the dialect the derived schemas are written in: they carry
 * their shared components under `$defs` and reference them by JSON pointer.
 */
const DRAFT = '2019-09';

const validators = new WeakMap<object, Validator>();

/**
 * A copy of the schema with every `format` keyword removed.
 *
 * `uuid`, `date-time` and the rest are annotations as far as this server is
 * concerned: the API is the authority on what it accepts, and a stricter local
 * reading of a format rejects values the API would have taken. Draft 2019-09
 * makes `format` annotation-only precisely for this reason, but the validator
 * asserts it, so the keyword is dropped rather than the dialect bent.
 */
function withoutFormat(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutFormat);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'format' && typeof value === 'string') continue;
    out[key] = withoutFormat(value);
  }
  return out;
}

export class ArgumentError extends Error {
  constructor(
    readonly toolName: string,
    readonly issues: string[],
  ) {
    super([`Invalid arguments for ${toolName}:`, ...issues.map((i) => `- ${i}`)].join('\n'));
    this.name = 'ArgumentError';
  }
}

/**
 * A tool produced structured output its own `outputSchema` does not describe.
 *
 * This is our bug, never the caller's, so it is reported as an internal
 * mismatch: a host that validates the advertised schema would otherwise reject
 * the result with no indication of which field diverged.
 */
export class OutputError extends Error {
  constructor(
    readonly toolName: string,
    readonly issues: string[],
  ) {
    super(
      [
        `Internal error: ${toolName} produced output that does not match its advertised outputSchema:`,
        ...issues.map((i) => `- ${i}`),
      ].join('\n'),
    );
    this.name = 'OutputError';
  }
}

/**
 * Build (and memoise) a validator for a schema.
 *
 * A schema that cannot be turned into a validator is a defect in the projection,
 * and it is announced: the marker goes to stderr and the error propagates.
 * Degrading to "no validation" would let every call through unchecked with
 * nothing in the logs to say so.
 */
function validatorFor(schema: object, owner: string): Validator {
  const cached = validators.get(schema);
  if (cached) return cached;
  try {
    const validator = new Validator(withoutFormat(schema) as Record<string, unknown>, DRAFT, false);
    validators.set(schema, validator);
    return validator;
  } catch (err) {
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(
        JSON.stringify({
          evt: 'schema_validator_build_failed',
          owner,
          message: err instanceof Error ? err.message : String(err),
        }) + '\n',
      );
    }
    throw err;
  }
}

/** One human-readable line per failing keyword, naming where it failed. */
function describe(errors: OutputUnit[]): string[] {
  return errors.map((err) => {
    const location = err.instanceLocation.replace(/^#\/?/, '').replace(/\//g, '.');
    return location ? `${location}: ${err.error}` : err.error;
  });
}

/** Human-readable issues against a tool's `inputSchema`. Empty when valid. */
export function findArgumentIssues(tool: Tool, args: unknown): string[] {
  const result = validatorFor(tool.inputSchema, tool.name).validate(args);
  return result.valid ? [] : describe(result.errors);
}

/** Throw when the arguments do not satisfy the tool's advertised contract. */
export function assertValidArguments(tool: Tool, args: unknown): void {
  const issues = findArgumentIssues(tool, args);
  if (issues.length > 0) throw new ArgumentError(tool.name, issues);
}

/** Human-readable issues against a tool's `outputSchema`. Empty when valid or absent. */
export function findOutputIssues(tool: Tool, value: unknown): string[] {
  if (!tool.outputSchema) return [];
  const result = validatorFor(tool.outputSchema, `${tool.name} (output)`).validate(value);
  return result.valid ? [] : describe(result.errors);
}

/** Throw when a tool's structured output does not match the schema it advertises. */
export function assertValidOutput(tool: Tool, value: unknown): void {
  const issues = findOutputIssues(tool, value);
  if (issues.length > 0) throw new OutputError(tool.name, issues);
}
