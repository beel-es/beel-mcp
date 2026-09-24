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
import { loadRules, type LoadedRules } from '../rules/fetch.js';
import { rulesCitingCode } from '../rules/render.js';

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

/** Most rules named under a failed call; the rest are one tool call away. */
export const MAX_RULES_PER_ERROR = 3;

/**
 * The published fiscal rules an error code enforces, as a short block to append
 * to an error: id, title and link per rule. Empty when no rule cites the code,
 * and empty — never an exception — when the catalogue cannot be read, because
 * the error itself is what the agent needs and must not be lost to this.
 */
export async function rulesNoteForCode(
  code: string | undefined,
  load: () => Promise<LoadedRules> = () => loadRules(),
): Promise<string> {
  if (!code) return '';
  try {
    const rules = rulesCitingCode((await load()).catalog, code);
    if (rules.length === 0) return '';
    const shown = rules.slice(0, MAX_RULES_PER_ERROR);
    return [
      `Rules behind ${code}:`,
      ...shown.map((rule) => `- ${rule.id} ${rule.title} — ${rule.url}`),
      rules.length > shown.length
        ? `(${rules.length - shown.length} more: beel_rules_get with error_code ${code})`
        : `(Full text: beel_rules_get with error_code ${code})`,
    ].join('\n');
  } catch {
    return '';
  }
}

/** {@link explainError}, followed by the rules the code enforces when there are any. */
export async function explainErrorWithRules(
  err: ExplainableError,
  load?: () => Promise<LoadedRules>,
): Promise<string> {
  const base = explainError(err);
  const note = await rulesNoteForCode(err.code, load);
  return note ? `${base}\n\n${note}` : base;
}
