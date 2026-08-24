import type { OperationSpec } from '../spec/manifest.js';
import type { KeyEnv } from '../config.js';
import { applyToolPolicy } from './tool-policy.js';

/**
 * Everything about OAuth scopes lives here — which ones the tools need, which
 * ones may be granted, and what a granted set implies. Keeping it in one module
 * is not tidiness: an earlier split kept two scope lists in two files and they
 * silently diverged (one advertised `business_profiles:*`, the other
 * `companies:*`), so a client could be sent to consent for a scope the backend
 * would reject.
 */

/** The scope that marks a session as operating on sandbox (test) data. */
export const SANDBOX_SCOPE = 'sandbox';

/**
 * Scopes never requested by default, even when the backend would grant them.
 *
 * `sandbox` NO está aquí, y esa ausencia es el arreglo: pedirlo no es *usarlo*.
 * El backend decide el entorno por el scope CONCEDIDO, y su pantalla de consentimiento
 * sólo sabe acotar lo que el cliente pidió — nunca añadir. Con `sandbox` fuera de la
 * petición, el selector de entorno de la pantalla no tenía nada que conceder y el token
 * salía SIEMPRE de producción, con el usuario creyendo lo contrario. Sobre facturación
 * eso son facturas fiscales reales, numeradas y enviadas a la AEAT.
 */
export const NON_DEFAULT_SCOPES = new Set<string>([]);

/**
 * Scopes requested upstream when the MCP client asks for none (Claude sends no
 * `scope` parameter) AND the backend's discovery document doesn't advertise its
 * catalogue. Deliberately conservative: it must remain a subset of what the
 * OLDEST deployed backend registers for this client, because Spring fails the
 * whole authorize with `invalid_scope` on a single unknown entry.
 *
 * New scopes must NOT be added here — they arrive automatically through
 * `scopes_supported` in the discovery document. This list only shrinks.
 */
export const FALLBACK_GRANTABLE_SCOPES: readonly string[] = [
  'invoices:read',
  'invoices:write',
  'customers:read',
  'customers:write',
  'products:read',
  'products:write',
  'configuration:read',
  'configuration:write',
  'series:read',
  'series:write',
  'nif:validate',
  'companies:read',
  'companies:write',
];

/**
 * Scopes an agent actually needs: the union across the tools the policy exposes.
 * Least privilege — the consent screen never asks for a scope no tool uses (e.g.
 * webhooks, excluded as infrastructure) nor omits one it does.
 */
export function requiredScopes(operations: OperationSpec[]): string[] {
  const { tools } = applyToolPolicy(operations);
  const scopes = new Set<string>();
  for (const tool of tools) for (const scope of tool.scopes) scopes.add(scope);
  return [...scopes].sort();
}

/**
 * Least-privilege intersection of what the tools NEED with what the backend
 * GRANTS. Pure — no runtime deps — so it is unit-testable from Node. Fails
 * CLOSED: an empty intersection returns `needed` (the tool set), NEVER the whole
 * grantable catalogue.
 *
 * `sandbox` se añade aparte y a propósito: no lo necesita ninguna herramienta —no es
 * un permiso— pero tiene que VIAJAR en la petición para que el selector de entorno de
 * la pantalla de consentimiento pueda concederlo. Pedirlo no fuerza sandbox: quien
 * decide es el usuario en esa pantalla, y sin su visto bueno el backend no lo concede.
 * Sólo se pide si el backend lo anuncia, porque Spring tumba el authorize entero con
 * `invalid_scope` ante una sola entrada desconocida.
 */
export function intersectScopes(needed: string[], grantable: readonly string[]): string[] {
  const grantableSet = new Set(grantable.filter((s) => !NON_DEFAULT_SCOPES.has(s)));
  const matched = needed.filter((s) => grantableSet.has(s));
  const scopes = matched.length ? matched : needed.filter((s) => !NON_DEFAULT_SCOPES.has(s));
  if (grantable.includes(SANDBOX_SCOPE) && !scopes.includes(SANDBOX_SCOPE)) {
    return [...scopes, SANDBOX_SCOPE];
  }
  return scopes;
}

/**
 * Which BeeL environment a granted scope set operates on. Defined once, and
 * read by both runtimes, so the two can never disagree about whether a session
 * is live.
 *
 * Absence of `sandbox` means LIVE, and that is deliberate: `sandbox` is never
 * granted by default, so a plain connection touches real fiscal data. The value
 * is surfaced to the agent precisely so it knows that.
 */
export function keyEnvFromScopes(scopes: readonly string[]): KeyEnv {
  return scopes.includes(SANDBOX_SCOPE) ? 'test' : 'live';
}
