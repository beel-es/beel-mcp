import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApiTools } from '../src/tools/api-tools.js';
import { docsTools } from '../src/tools/docs-tools.js';
import { workflowTools } from '../src/tools/workflow-tools.js';
import {
  assertValidArguments,
  assertValidOutput,
  findArgumentIssues,
  findOutputIssues,
} from '../src/tools/validate-args.js';

const { tools } = buildApiTools();
const byName = new Map(tools.map((t) => [t.tool.name, t.tool]));

describe('argument validation against the derived inputSchema', () => {
  it('builds a validator for every schema the server advertises', () => {
    // A schema the validator cannot take is a defect in the projection. It must
    // fail here rather than at a user's call, where it now propagates instead of
    // degrading to no validation at all.
    const all = [...tools.map((t) => t.tool), ...docsTools, ...workflowTools];
    const rejected = all.filter((tool) => {
      try {
        findArgumentIssues(tool, {});
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected.map((t) => t.name)).toEqual([]);
  });

  it('reports a missing required argument by name', () => {
    const tool = byName.get('beel_create_invoice');
    expect(tool).toBeDefined();
    expect(findArgumentIssues(tool!, {}).join(' ')).toMatch(/company_id/);
  });

  it('rejects a wrongly typed argument', () => {
    const tool = byName.get('beel_create_invoice');
    expect(() => assertValidArguments(tool!, { company_id: 123 })).toThrow(/company_id/);
  });

  it('accepts arguments that satisfy the contract', () => {
    const tool = byName.get('beel_list_companies');
    expect(tool).toBeDefined();
    expect(
      findArgumentIssues(tool!, { account_id: '9c8f1f2e-2b7a-4a1e-9d1f-3f5a8c2b7e10' }),
    ).toEqual([]);
  });

  it('resolves the $defs the projection emits for shared schemas', () => {
    // The derived schemas keep shared components under $defs and reference them
    // by pointer; a validator that ignored them would accept anything nested.
    const tool = byName.get('beel_create_invoice')!;
    const schema = tool.inputSchema as { $defs?: Record<string, unknown> };
    expect(Object.keys(schema.$defs ?? {}).length).toBeGreaterThan(0);
    expect(
      findArgumentIssues(tool, {
        company_id: '9c8f1f2e-2b7a-4a1e-9d1f-3f5a8c2b7e10',
        body: { lines: 'not an array' },
      }).join(' '),
    ).toMatch(/lines/);
  });
});

describe('formats are annotations, not local rejections', () => {
  it('does not reject a value the API may well accept', () => {
    // The API is the authority on what a uuid or a date-time is. A stricter
    // local reading rejects calls that would have succeeded.
    const tool = byName.get('beel_list_companies')!;
    expect(findArgumentIssues(tool, { account_id: 'not-a-uuid' })).toEqual([]);
  });
});

describe('unknown top-level arguments', () => {
  const tool = byName.get('beel_list_companies')!;

  it('are rejected once the derived schema closes the object', () => {
    // The projection decides whether `additionalProperties: false` is emitted.
    // Until it is, an unknown key is legal JSON Schema and nothing here can say
    // otherwise, so this case reports rather than fails. See HANDOFF.md.
    const closed =
      (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties === false;
    const issues = findArgumentIssues(tool, { account_id: 'a', not_a_parameter: 1 });
    if (!closed) {
      expect(issues).toEqual([]);
      return;
    }
    expect(issues.join(' ')).toMatch(/not_a_parameter/);
  });
});

describe('the validator runs where the remote transport runs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('validates without constructing a Function', () => {
    // Cloudflare Workers forbid `new Function`. A code-generating validator
    // throws there, and a caught throw means every remote call goes out
    // unvalidated — which is indistinguishable from validation passing.
    const spy = vi.spyOn(globalThis, 'Function' as never);
    const tool = byName.get('beel_create_invoice')!;
    expect(() => assertValidArguments(tool, { company_id: 123 })).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('output validation', () => {
  const tool = workflowTools[0]!;

  it('accepts output that matches the advertised outputSchema', () => {
    expect(
      findOutputIssues(tool, {
        environment: 'test',
        account: { account_id: 'a' },
        companies: [],
        next_action: 'do the thing',
      }),
    ).toEqual([]);
  });

  it('names the field when a tool produces something its schema does not describe', () => {
    expect(() =>
      assertValidOutput(tool, {
        environment: 'staging',
        account: {},
        companies: [],
        next_action: 'x',
      }),
    ).toThrow(/environment/);
  });

  it('is a no-op for a tool that advertises no outputSchema', () => {
    expect(findOutputIssues(docsTools[0]!, { anything: true })).toEqual([]);
  });
});
