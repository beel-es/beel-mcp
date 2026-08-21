/**
 * Turns an API error into something an agent can act on.
 *
 * Relaying `BeeL API error (422): code EMISSION_NOT_READY` tells a model that
 * something failed and nothing about what to do next, so it retries the same
 * call or invents a fix. Every error the server surfaces goes through here and
 * comes out with the condition, the remedy, and — where the API nests specifics
 * in `error.details` — those too.
 *
 * Nothing is invented: the text comes from `catalog.ts`, which is transcribed
 * from the contract. An unknown code degrades to the API's own message rather
 * than to a guess.
 */

import { lookupError, type CatalogEntry } from './catalog.js';
import { guardrailUri } from './rules.js';

export interface ExplainableError {
  status: number;
  message: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

/** Codes nested inside `error.details.blockers[]` (EMISSION_NOT_READY does this). */
function nestedBlockers(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const blockers = (details as Record<string, unknown>).blockers;
  return Array.isArray(blockers) ? blockers.filter((b): b is string => typeof b === 'string') : [];
}

/** Pull the fields the catalogue says are worth surfacing verbatim. */
function relevantDetails(entry: CatalogEntry | undefined, details: unknown): string[] {
  if (!entry?.detailKeys || !details || typeof details !== 'object') return [];
  const record = details as Record<string, unknown>;
  return entry.detailKeys
    .filter((key) => key !== 'blockers' && record[key] !== undefined)
    .map((key) => `${key}: ${JSON.stringify(record[key])}`);
}

/**
 * Render an error as text for the agent. Deliberately plain prose rather than a
 * JSON dump: this string is read by a model, and a model acts on instructions
 * far more reliably than on a nested object it has to interpret first.
 */
export function explainError(err: ExplainableError): string {
  const entry = lookupError(err.code);
  const lines: string[] = [`BeeL API error ${err.status}: ${err.message}`];

  if (err.code) lines.push(`code: ${err.code}`);

  if (entry) {
    lines.push('', `What this means: ${entry.meaning}`, `What to do: ${entry.remedy}`);
    if (entry.actor === 'benign') {
      lines.push(
        'Note: this is not necessarily a failure — the operation may have already succeeded.',
      );
    }
    if (entry.actor === 'access' || entry.actor === 'configuration') {
      lines.push('Retrying this call unchanged will not help.');
    }
    if (entry.guardrail) {
      lines.push(`Background: ${guardrailUri(entry.guardrail)}`);
    }
  }

  // EMISSION_NOT_READY is a container: the real reasons are the nested blockers,
  // and each of those has its own catalogue entry with its own remedy.
  const blockers = nestedBlockers(err.details);
  if (blockers.length > 0) {
    lines.push('', 'Blockers reported, each with its own fix:');
    for (const blocker of blockers) {
      const nested = lookupError(blocker);
      lines.push(
        nested
          ? `- ${blocker}: ${nested.meaning}\n  Fix: ${nested.remedy}`
          : `- ${blocker}`,
      );
    }
  }

  const extras = relevantDetails(entry, err.details);
  if (extras.length > 0) lines.push('', ...extras);

  // Keep the raw details when nothing above consumed them, so nothing is lost.
  if (err.details !== undefined && blockers.length === 0 && extras.length === 0) {
    lines.push('', `details: ${JSON.stringify(err.details)}`);
  }

  if (err.requestId) lines.push('', `request_id: ${err.requestId}`);
  return lines.join('\n');
}

/** One-line explanation of a bare code, for compact reports (setup status). */
export function explainCode(code: string): string {
  const entry = lookupError(code);
  return entry ? entry.remedy : `Resolve ${code}.`;
}
