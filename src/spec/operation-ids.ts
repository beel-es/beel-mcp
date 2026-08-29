/**
 * The operationIds the contract declares.
 *
 * An operationId written as a literal in `src/` — a guardrail binding, a
 * destructive-operation entry, a tool↔app binding — is a claim about the
 * contract, and a claim that stops being true fails silently: the binding stops
 * binding and nothing reports it. `requireOperationId` turns that into a startup
 * error, and the set is what the tests assert every literal against.
 */
import { specManifest } from './manifest.js';

let cached: ReadonlySet<string> | null = null;

/** Every operationId in the contract, whether or not policy exposes it as a tool. */
export function operationIds(): ReadonlySet<string> {
  return (cached ??= new Set(specManifest().map((op) => op.operationId)));
}

/** Assert an operationId exists in the contract, and return it unchanged. */
export function requireOperationId<T extends string>(id: T): T {
  if (!operationIds().has(id)) {
    throw new Error(`Unknown operationId "${id}": it is not declared in the OpenAPI contract.`);
  }
  return id;
}
