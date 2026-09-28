/**
 * The parts of a contract description an agent reads: sentences, the first of
 * them, and the ones that state a requirement or a rejection.
 *
 * Descriptions in the contract are written for a human reading the reference:
 * a summary, then background, examples and the rules, often in that order. An
 * agent building a call needs the summary and the rules, and the rules are
 * rarely first ("Mandatory on NORMAL lines", "CORRECTIVE is not accepted
 * here"). These helpers keep both, within a stated budget, and never cut a
 * sentence where the fragment would say something false.
 */

/** Longest first sentence a description keeps, e.g. under a schema heading. */
export const MAX_FIELD_DESCRIPTION_CHARS = 120;
/**
 * Longest description a field carries. Its first sentence, then each later
 * sentence that states a requirement or a rejection, while they fit: the part of
 * a description that decides whether a call is accepted is rarely the first
 * sentence ("Mandatory on NORMAL lines", "CORRECTIVE is not accepted here").
 */
export const MAX_FIELD_CONSTRAINT_CHARS = 280;
/**
 * Most characters of requirement and rejection sentences an input-schema
 * description keeps after its first paragraph. The rest of a long description
 * (background, examples, history) stays in the contract, the docs and the rules.
 */
export const MAX_SCHEMA_CONSTRAINT_CHARS = 280;
/** A sentence that says what is required or refused. */
const CONSTRAINT_WORDS =
  /\b(mandatory|required|must|not accepted|not allowed|rejected|refused|forbidden)\b/i;
/** An error code, which only a rejection names. */
const ERROR_CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/;
/** Says a field is needed, not that it is not. */
export const REQUIREMENT = /\b(mandatory|required)\b/i;

/** A blank line, which ends a Markdown paragraph. */
const PARAGRAPH_BREAK = /\n\s*\n/;
const PARAGRAPH = '\n\n';

/** A description on one line, without Markdown emphasis. */
function flatten(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** Abbreviations whose full stop ends no sentence ("e.g.", "art. 78", "arts. 6"). */
const ABBREVIATION = /\b(e\.g|i\.e|arts?|etc|vs|approx|No)$/i;

/**
 * The sentences of a description, in order. A full stop ends one unless it
 * closes an {@link ABBREVIATION}; a colon that opens a list does too, and the
 * list is dropped with it.
 */
function sentences(text: string): string[] {
  const flat = flatten(text);
  const out: string[] = [];
  let start = 0;
  for (const match of flat.matchAll(/[.!?](?=\s|$)|:(?=\s+[-*]\s)/g)) {
    if (ABBREVIATION.test(flat.slice(0, match.index))) continue;
    out.push(flat.slice(start, match.index + 1).trim());
    if (match[0] === ':') return out;
    start = match.index + 1;
  }
  const rest = flat.slice(start).trim();
  return rest ? [...out, rest] : out;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The first sentence of a description, on one line, without Markdown emphasis. */
export function firstSentence(text: unknown, max = MAX_FIELD_DESCRIPTION_CHARS): string {
  if (typeof text !== 'string') return '';
  return cut(sentences(text)[0] ?? '', max);
}

/**
 * Where a sentence may be cut and still say something true: after a semicolon
 * or a colon, before a dash, or before a clause joined by "and", "but" or
 * "which". Never at a bare comma, which may sit inside a list ("one of `a`,
 * `b` or `c`") whose first item alone would say the opposite.
 */
const CLAUSE_BOUNDARY = /(?<=[;:])\s|\s(?=—\s)|(?<=,)\s(?=(?:and|but|which)\s)/;

/**
 * The longest run of a sentence's leading clauses that fits in `room`, closed
 * with a full stop, or `undefined` when not even the first clause does.
 */
function leadingClauses(sentence: string, room: number): string | undefined {
  const clauses = sentence.split(CLAUSE_BOUNDARY);
  let best: string | undefined;
  for (let n = 1; n <= clauses.length; n++) {
    const text = clauses
      .slice(0, n)
      .join(' ')
      .replace(/[\s,;:.—]*$/, '.');
    if (text.length > room) break;
    best = text;
  }
  return best;
}

/** Whether a sentence says what is required or rejected. */
function isConstraint(sentence: string): boolean {
  return CONSTRAINT_WORDS.test(sentence) || ERROR_CODE.test(sentence);
}

/**
 * `lead`, then every candidate sentence that states a requirement or a
 * rejection, in order, while the whole stays within `max`. A constraint too
 * long to fit keeps its leading clauses, which is where the rule and the error
 * code usually are; one that does not fit at all is skipped, not the end, since a
 * shorter one after it may still.
 */
function withConstraints(lead: string, candidates: string[], max: number): string {
  let out = lead;
  for (const sentence of candidates) {
    if (!isConstraint(sentence)) continue;
    const room = max - out.length - 1;
    const kept = sentence.length <= room ? sentence : leadingClauses(sentence, room);
    if (kept) out = out ? `${out} ${kept}` : kept;
  }
  return out;
}

/**
 * What a field's comment in `beel_schema_get` says: its first sentence, then
 * the later sentences that state a requirement or a rejection, within
 * {@link MAX_FIELD_CONSTRAINT_CHARS}.
 */
export function fieldDescription(text: unknown): string {
  if (typeof text !== 'string') return '';
  const [first = '', ...rest] = sentences(text);
  return withConstraints(cut(first, MAX_FIELD_DESCRIPTION_CHARS), rest, MAX_FIELD_CONSTRAINT_CHARS);
}

/**
 * What a description says inside a tool's input schema, which every request
 * carries: its first paragraph as written, then the requirement and rejection
 * sentences of the rest, within {@link MAX_SCHEMA_CONSTRAINT_CHARS} more.
 */
export function schemaDescription(text: string): string {
  const [first = '', ...rest] = text.trim().split(PARAGRAPH_BREAK);
  const lead = first.trim();
  if (rest.length === 0) return lead;
  const extra = withConstraints('', sentences(rest.join(' ')), MAX_SCHEMA_CONSTRAINT_CHARS);
  return extra ? `${lead}${PARAGRAPH}${extra}` : lead;
}
