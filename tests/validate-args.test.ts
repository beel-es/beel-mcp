import { describe, expect, it } from 'vitest';
import { buildApiTools } from '../src/tools/api-tools.js';
import { assertValidArguments, findArgumentIssues } from '../src/tools/validate-args.js';

const { tools } = buildApiTools();
const byName = new Map(tools.map((t) => [t.tool.name, t.tool]));

describe('argument validation against the derived inputSchema', () => {
  it('compiles every schema derived from the spec', () => {
    // Guards the `strict: false` escape hatch in validate-args.ts: if an OpenAPI
    // keyword ever defeats Ajv, it fails here and not silently in production.
    const uncompilable = tools.filter((t) => {
      try {
        findArgumentIssues(t.tool, {});
        return false;
      } catch {
        return true;
      }
    });
    expect(uncompilable).toEqual([]);
  });

  it('reports a missing required argument by name', () => {
    const tool = byName.get('beel_create_invoice');
    expect(tool).toBeDefined();
    const issues = findArgumentIssues(tool!, {});
    expect(issues.join(' ')).toMatch(/company_id/);
  });

  it('rejects a wrongly typed argument', () => {
    const tool = byName.get('beel_create_invoice');
    expect(() => assertValidArguments(tool!, { company_id: 123 })).toThrow(/company_id/);
  });

  it('accepts arguments that satisfy the contract', () => {
    const tool = byName.get('beel_list_companies');
    expect(tool).toBeDefined();
    expect(findArgumentIssues(tool!, { account_id: '9c8f1f2e-2b7a-4a1e-9d1f-3f5a8c2b7e10' })).toEqual([]);
  });
});
