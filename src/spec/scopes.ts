/**
 * The OAuth scopes the contract declares, in `x-required-scopes`.
 *
 * A scope requested but not declared is one Spring rejects the whole authorize
 * with (`invalid_scope`), so a stale literal here is a connection that cannot be
 * established rather than a permission quietly missing.
 */
import { specManifest } from './manifest.js';

let cached: ReadonlySet<string> | null = null;

/** Every scope named by some operation's `x-required-scopes`. */
export function specScopes(): ReadonlySet<string> {
  if (cached) return cached;
  const all = new Set<string>();
  for (const op of specManifest()) for (const scope of op.scopes) all.add(scope);
  cached = all;
  return all;
}

/** Assert a scope is declared by some operation in the contract, and return it. */
export function requireScope<T extends string>(scope: T): T {
  if (!specScopes().has(scope)) {
    throw new Error(`Unknown scope "${scope}": no operation declares it in x-required-scopes.`);
  }
  return scope;
}
