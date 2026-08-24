import { describe, expect, it } from 'vitest';
import { intersectScopes, keyEnvFromScopes, SANDBOX_SCOPE } from '../src/policy/scopes.js';

const NEEDED = ['invoices:read', 'invoices:write', 'companies:list', 'nif:validate'];

describe('intersectScopes (least-privilege, fail-closed)', () => {
  it('returns tools ∩ grantable when they overlap', () => {
    const grantable = ['invoices:read', 'invoices:write', 'companies:list', 'nif:validate', 'members:read'];
    expect(intersectScopes(NEEDED, grantable).sort()).toEqual(
      ['companies:list', 'invoices:read', 'invoices:write', 'nif:validate'].sort(),
    );
  });

  it('fails CLOSED to the tool set on empty intersection — never the whole catalog', () => {
    // grantable uses different scope names (drift) → intersection empty.
    const grantable = ['x:read', 'y:write'];
    const result = intersectScopes(NEEDED, grantable);
    expect(result).toEqual(NEEDED); // the least-privilege tool set, NOT grantable
    expect(result).not.toContain('x:read');
  });

  it('does not over-privilege beyond what tools need', () => {
    const grantable = ['invoices:read', 'accounts:write', 'account:admin']; // privileged extras
    expect(intersectScopes(NEEDED, grantable)).toEqual(['invoices:read']);
  });

  describe('sandbox: pedirlo es lo que permite ELEGIRLO', () => {
    // El backend decide el entorno por el scope CONCEDIDO, y su consent sólo acota lo
    // pedido. Con `sandbox` fuera de la petición, el selector de entorno de la pantalla
    // no tenía nada que conceder y el token salía SIEMPRE de producción.

    it('viaja en la petición cuando el backend lo anuncia', () => {
      const grantable = ['invoices:read', 'invoices:write', 'companies:list', 'nif:validate', SANDBOX_SCOPE];
      expect(intersectScopes(NEEDED, grantable)).toContain(SANDBOX_SCOPE);
    });

    it('no se pide si el backend NO lo anuncia — un scope desconocido tumba el authorize entero', () => {
      const grantable = ['invoices:read', 'invoices:write', 'companies:list', 'nif:validate'];
      expect(intersectScopes(NEEDED, grantable)).not.toContain(SANDBOX_SCOPE);
    });

    it('también viaja cuando la intersección cae al fallback', () => {
      expect(intersectScopes(NEEDED, ['x:read', SANDBOX_SCOPE])).toEqual([...NEEDED, SANDBOX_SCOPE]);
    });

    it('no se duplica si ya venía', () => {
      const result = intersectScopes([...NEEDED, SANDBOX_SCOPE], ['invoices:read', SANDBOX_SCOPE]);
      expect(result.filter((s) => s === SANDBOX_SCOPE)).toHaveLength(1);
    });

    it('pedirlo NO es obtenerlo: el entorno lo sigue decidiendo lo CONCEDIDO', () => {
      // Lo que el usuario aprueba en la pantalla es lo que vuelve en el token.
      expect(keyEnvFromScopes(['invoices:read'])).toBe('live');
      expect(keyEnvFromScopes(['invoices:read', SANDBOX_SCOPE])).toBe('test');
    });
  });
});
