import type { OperationSpec } from '../spec/manifest.js';
import type { KeyEnv } from '../config.js';
import { specManifest } from '../spec/manifest.js';
import { applyToolPolicy } from './tool-policy.js';

/**
 * Everything about OAuth scopes lives here — which ones the tools need, which
 * ones may be granted, and what a granted set implies. One module rather than
 * one per consumer: two scope lists in two files are two things to remember, and
 * when they disagree the failure surfaces on the consent screen, as a scope the
 * backend rejects, rather than in a test.
 */

/**
 * The scope that selects the sandbox environment.
 *
 * It is not a permission — no tool needs it — but it must travel in the
 * authorize request all the same: the consent screen can only narrow what the
 * client asked for, never add to it, so a request without `sandbox` leaves the
 * screen's environment selector with nothing to grant and every token comes back
 * live. Asking for it does not select sandbox; the user does, on that screen,
 * and the backend grants it only if they pick Test.
 */
export const SANDBOX_SCOPE = 'sandbox';

/**
 * The scope families the fallback may request.
 *
 * The fallback is what the upstream is asked for when the MCP client sends no
 * `scope` and the backend's discovery document does not advertise its catalogue.
 * It must stay a subset of what the OLDEST deployed backend registers for this
 * client, because Spring fails the whole authorize with `invalid_scope` on a
 * single unknown entry — so this list only ever shrinks. Newer scopes need no
 * entry: they arrive through `scopes_supported` in the discovery document, and
 * that path is the normal one.
 */
const FALLBACK_ALLOWLIST: ReadonlySet<string> = new Set([
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
]);

let cachedFallback: readonly string[] | null = null;

/**
 * The fallback scope set: what the tools need, narrowed to the families above.
 *
 * Derived rather than written out, so it can never ask for a scope no exposed
 * tool uses. Computed on first call — the Worker injects the spec after every
 * import has been evaluated.
 */
export function fallbackGrantableScopes(): readonly string[] {
  return (cachedFallback ??= requiredScopes(specManifest()).filter((s) =>
    FALLBACK_ALLOWLIST.has(s),
  ));
}

/** The allowlist itself, so a test can catch an entry that no longer resolves. */
export function fallbackAllowlist(): ReadonlySet<string> {
  return FALLBACK_ALLOWLIST;
}

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
 * GRANTS. Pure — no runtime dependencies — so it is unit-testable from Node.
 *
 * Fails CLOSED: when nothing intersects, the result is `needed` (the tool set),
 * never the grantable catalogue. Drift in the backend's scope names must not
 * turn into a broader grant than the tools asked for.
 *
 * `sandbox` is added separately and on purpose. It is not a permission and no
 * tool needs it, but the consent screen can only narrow the request it was
 * given: without `sandbox` in it, the screen's environment selector has nothing
 * to grant. It is only added when the backend advertises it, because one
 * unknown entry fails the whole authorize.
 */
export function intersectScopes(needed: string[], grantable: readonly string[]): string[] {
  const grantableSet = new Set(grantable);
  const matched = needed.filter((s) => grantableSet.has(s));
  const scopes = matched.length ? matched : [...needed];
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
 * Absence of `sandbox` means LIVE, and that is deliberate: it is never granted
 * by default, so a plain connection touches real fiscal data. The value is
 * surfaced to the agent precisely so that it knows.
 */
export function keyEnvFromScopes(scopes: readonly string[]): KeyEnv {
  return scopes.includes(SANDBOX_SCOPE) ? 'test' : 'live';
}
