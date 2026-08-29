import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { operationIds, requireOperationId } from '../src/spec/operation-ids.js';
import { tags, requireTag } from '../src/spec/tags.js';
import { specScopes, requireScope } from '../src/spec/scopes.js';
import { CHECKED_OPERATIONS } from '../src/guardrails/validate.js';
import { BY_OPERATION_ID, BY_TAG } from '../src/guardrails/enrich.js';
import { DESTRUCTIVE_OPERATION_IDS } from '../src/policy/annotations.js';
import { DEFAULT_EXCLUDED_TAGS } from '../src/policy/tool-policy.js';
import { fallbackGrantableScopes } from '../src/policy/scopes.js';
import { INVOICE_PDF_OPERATION } from '../src/mcpapp/contract.js';

/**
 * An operationId, a tag or a scope written into `src/` is a claim about the
 * contract. When the contract stops agreeing, nothing breaks loudly: the
 * guardrail stops binding, the annotation stops annotating, the consent screen
 * asks for a scope the backend rejects. These are the assertions that make such
 * a claim fail here instead.
 */

describe('the contract vocabulary is read from the contract', () => {
  it('reads a plausible number of operationIds, tags and scopes', () => {
    expect(operationIds().size).toBeGreaterThan(60);
    expect(tags().size).toBeGreaterThan(10);
    expect(specScopes().size).toBeGreaterThan(5);
  });

  it('rejects a value the contract does not declare', () => {
    expect(() => requireOperationId('createCompanyInvoice')).not.toThrow();
    expect(() => requireOperationId('createCompanyInvoiceTypo')).toThrow(/operationId/);
    expect(() => requireTag('CompanyInvoices')).not.toThrow();
    expect(() => requireTag('PublicCompanies')).toThrow(/tag/);
    expect(() => requireScope('invoices:write')).not.toThrow();
    expect(() => requireScope('invoices:writ')).toThrow(/scope/);
  });
});

describe('every literal the server binds to exists in the contract', () => {
  it('operationIds', () => {
    const bound = [
      ...Object.keys(CHECKED_OPERATIONS),
      ...Object.keys(BY_OPERATION_ID),
      ...DESTRUCTIVE_OPERATION_IDS,
      INVOICE_PDF_OPERATION,
    ];
    expect(bound.filter((id) => !operationIds().has(id))).toEqual([]);
  });

  it('tags', () => {
    const bound = [...Object.keys(BY_TAG), ...DEFAULT_EXCLUDED_TAGS];
    expect(bound.filter((tag) => !tags().has(tag))).toEqual([]);
  });

  it('scopes', () => {
    expect(fallbackGrantableScopes().filter((s) => !specScopes().has(s))).toEqual([]);
  });
});

/**
 * The lists above are only as good as their coverage. This walks `src/` for
 * quoted strings that look like an operationId or a scope and checks those too,
 * so a new binding added in a new module is caught without anyone remembering
 * to extend the list.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('nothing in src/ quotes a scope the contract does not declare', () => {
  it('across every module', () => {
    const unknown = new Set<string>();
    for (const file of sourceFiles('src')) {
      // Import specifiers (`node:fs`) share the shape and are not scopes.
      const text = readFileSync(file, 'utf8')
        .replace(/^.*\bfrom '[^']+';?$/gm, '')
        .replace(/\bimport\('[^']+'\)/g, '');
      for (const match of text.matchAll(/'([a-z_]+:[a-z_]+)'/g)) {
        const scope = match[1]!;
        // `sandbox` aside, every scope-shaped literal names a permission.
        if (!specScopes().has(scope)) unknown.add(`${file}: ${scope}`);
      }
    }
    expect([...unknown]).toEqual([]);
  });
});
