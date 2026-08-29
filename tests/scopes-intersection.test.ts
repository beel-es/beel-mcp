import { describe, expect, it } from 'vitest';
import {
  fallbackAllowlist,
  fallbackGrantableScopes,
  intersectScopes,
  keyEnvFromScopes,
  requiredScopes,
  SANDBOX_SCOPE,
} from '../src/policy/scopes.js';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { specScopes } from '../src/spec/scopes.js';

const NEEDED = ['invoices:read', 'invoices:write', 'companies:list', 'nif:validate'];

describe('intersectScopes (least-privilege, fail-closed)', () => {
  it('returns tools ∩ grantable when they overlap', () => {
    const grantable = [...NEEDED, 'members:read'];
    expect(intersectScopes(NEEDED, grantable).sort()).toEqual([...NEEDED].sort());
  });

  it('falls back to the tool set on an empty intersection, never to the catalogue', () => {
    // The backend's names have drifted, so nothing matches. Widening the request
    // to everything the backend offers would trade a failed connection for an
    // over-privileged one, which is the worse of the two.
    const result = intersectScopes(NEEDED, ['x:read', 'y:write']);
    expect(result).toEqual(NEEDED);
    expect(result).not.toContain('x:read');
  });

  it('does not ask for a privilege no tool uses', () => {
    const grantable = ['invoices:read', 'accounts:write', 'account:admin'];
    expect(intersectScopes(NEEDED, grantable)).toEqual(['invoices:read']);
  });

  describe('sandbox: asking for it is what makes it choosable', () => {
    // The environment is decided by the scope the backend GRANTS, and the
    // consent screen can only narrow the request it was given — never add to
    // it. Left out of the request, the screen's environment selector has
    // nothing to grant and every token comes back live, whatever the user
    // picked. On an invoicing API that is real numbered invoices sent to AEAT.

    it('travels in the request when the backend advertises it', () => {
      expect(intersectScopes(NEEDED, [...NEEDED, SANDBOX_SCOPE])).toContain(SANDBOX_SCOPE);
    });

    it('is not requested when the backend does not advertise it', () => {
      // One unknown entry fails the whole authorize with `invalid_scope`.
      expect(intersectScopes(NEEDED, NEEDED)).not.toContain(SANDBOX_SCOPE);
    });

    it('travels even when the intersection fell back to the tool set', () => {
      expect(intersectScopes(NEEDED, ['x:read', SANDBOX_SCOPE])).toEqual([
        ...NEEDED,
        SANDBOX_SCOPE,
      ]);
    });

    it('is never requested twice', () => {
      const result = intersectScopes([...NEEDED, SANDBOX_SCOPE], ['invoices:read', SANDBOX_SCOPE]);
      expect(result.filter((s) => s === SANDBOX_SCOPE)).toHaveLength(1);
    });

    it('asking is not obtaining: the environment follows what was granted', () => {
      expect(keyEnvFromScopes(['invoices:read'])).toBe('live');
      expect(keyEnvFromScopes(['invoices:read', SANDBOX_SCOPE])).toBe('test');
    });
  });
});

describe('the scope sets nest, from the contract outwards', () => {
  const manifest = buildManifest(loadSpec());

  it('every scope a tool needs is one the contract declares', () => {
    // requiredScopes is a union over exposed tools; if it could exceed the
    // contract it would be asking for a permission that does not exist.
    expect(requiredScopes(manifest).filter((s) => !specScopes().has(s))).toEqual([]);
  });

  it('the fallback never exceeds what the tools need', () => {
    const needed = new Set(requiredScopes(manifest));
    expect(fallbackGrantableScopes().filter((s) => !needed.has(s))).toEqual([]);
  });

  it('the fallback allowlist has no entry that stopped resolving', () => {
    // An entry the tools no longer need is silently dropped from the derived
    // fallback. That is safe, but it is also a line nobody will ever delete.
    const needed = new Set(requiredScopes(manifest));
    expect([...fallbackAllowlist()].filter((s) => !needed.has(s))).toEqual([]);
  });

  it('the fallback is not empty, so a discovery failure still connects', () => {
    expect(fallbackGrantableScopes().length).toBeGreaterThan(0);
  });
});
