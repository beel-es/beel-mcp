import { describe, expect, it } from 'vitest';
import { intersectScopes } from '../src/policy/tool-policy.js';

const NEEDED = ['invoices:read', 'invoices:write', 'companies:list', 'nif:validate'];

describe('intersectScopes (least-privilege, fail-closed)', () => {
  it('returns tools ∩ grantable when they overlap', () => {
    const grantable = ['invoices:read', 'invoices:write', 'companies:list', 'nif:validate', 'members:read', 'sandbox'];
    expect(intersectScopes(NEEDED, grantable).sort()).toEqual(
      ['companies:list', 'invoices:read', 'invoices:write', 'nif:validate'].sort(),
    );
  });

  it('never includes a non-default scope (sandbox) even if grantable lists it', () => {
    expect(intersectScopes(['invoices:read', 'sandbox'], ['invoices:read', 'sandbox'])).not.toContain('sandbox');
  });

  it('fails CLOSED to the tool set on empty intersection — never the whole catalog', () => {
    // grantable uses different scope names (drift) → intersection empty.
    const grantable = ['x:read', 'y:write', 'sandbox'];
    const result = intersectScopes(NEEDED, grantable);
    expect(result).toEqual(NEEDED); // the least-privilege tool set, NOT grantable
    expect(result).not.toContain('x:read');
  });

  it('does not over-privilege beyond what tools need', () => {
    const grantable = ['invoices:read', 'accounts:write', 'account:admin']; // privileged extras
    expect(intersectScopes(NEEDED, grantable)).toEqual(['invoices:read']);
  });
});
