/**
 * Renders an API error for the model.
 *
 * The API's own message leads and its `error.details` are printed whole — never
 * a curated subset. The API puts things there (`defaults_status_endpoint`,
 * `company_id`, `missing_scopes`) more useful than anything written locally, and
 * a filter here can only ever remove the field the agent turned out to need.
 *
 * On top of that this adds only what the response cannot carry: the tool call
 * that resolves it, whether retrying is worth attempting, and — for the bare
 * blocker codes nested inside `details.blockers[]` — a documentation link, since
 * those arrive as unadorned strings. See `catalog.ts` for why the list is short.
 */

import { docsUrlForCode, lookupError } from './catalog.js';
import { guardrailUri } from './rules.js';

export interface ExplainableError {
  status: number;
  message: string;
  code?: string;
  details?: unknown;
  requestId?: string;
  /** RFC 7807 `type` from the envelope: the documentation page for this code. */
  docsUrl?: string;
}

/** Codes nested inside `error.details.blockers[]` (EMISSION_NOT_READY does this). */
function nestedBlockers(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const blockers = (details as Record<string, unknown>).blockers;
  return Array.isArray(blockers) ? blockers.filter((b): b is string => typeof b === 'string') : [];
}

export function explainError(err: ExplainableError): string {
  const entry = lookupError(err.code);
  const lines: string[] = [`BeeL API error ${err.status}: ${err.message}`];

  if (err.code) lines.push(`code: ${err.code}`);

  // Prefer the URL the API sent; fall back to building it from the code.
  const docs = err.docsUrl ?? (err.code ? docsUrlForCode(err.code) : undefined);
  if (docs) lines.push(`docs: ${docs}`);

  if (entry?.remedy) lines.push('', `What to do: ${entry.remedy}`);

  if (entry?.actor === 'benign') {
    lines.push('', 'This is not necessarily a failure — the operation may have already succeeded.');
  } else if (entry?.actor === 'access' || entry?.actor === 'configuration') {
    lines.push('', 'Retrying this call unchanged will not help.');
  }

  if (entry?.guardrail) lines.push(`Background: ${guardrailUri(entry.guardrail)}`);

  // The container codes: blockers arrive as bare strings with no message and no
  // link of their own, so each gets the tool call that clears it and its page.
  const blockers = nestedBlockers(err.details);
  if (blockers.length > 0) {
    lines.push('', 'Blockers reported, each resolved separately:');
    for (const blocker of blockers) {
      const remedy = lookupError(blocker)?.remedy;
      lines.push(
        `- ${blocker} — ${docsUrlForCode(blocker)}` + (remedy ? `\n  Fix: ${remedy}` : ''),
      );
    }
  }

  if (err.details !== undefined) lines.push('', `details: ${JSON.stringify(err.details)}`);
  if (err.requestId) lines.push('', `request_id: ${err.requestId}`);

  return lines.join('\n');
}

/**
 * One-line next action for a bare code, used by compact reports. Falls back to
 * the documentation link, which is always more useful than a generic sentence.
 */
export function explainCode(code: string): string {
  return lookupError(code)?.remedy ?? `See ${docsUrlForCode(code)}`;
}
