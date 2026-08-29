/**
 * Executable guardrails — the checks that run BEFORE a mutating call is sent.
 *
 * Scope is deliberate and narrow. A rule belongs here only if it is a
 * cross-field invariant the operation's JSON Schema cannot express: the schema
 * already rejects missing required fields and bad enums, and repeating that
 * would only add a second place to keep in sync.
 *
 * Every rule mirrors a rejection the OpenAPI contract documents, so this layer
 * is a strict subset of what the API refuses. A pre-flight failure is therefore
 * a verdict the call was going to receive anyway — delivered earlier, cheaper,
 * and with the fix attached. It can never make the server permissive, only
 * faster to correct. Blocking here also means the request never consumes an
 * idempotency key, so retrying after the fix is clean.
 *
 * What is NOT here is as deliberate: rules the backend owns because they depend
 * on state this process cannot see — AEAT census matching, the 3 000 € F2
 * ceiling (computed over server-side totals), the VeriFactu gates, whether a
 * series exists. Guessing at those would reject valid invoices, which is far
 * worse than letting the API answer. Their prose lives in `rules/*.md`.
 */

import { ENV_VAR } from '../shared/defaults.js';
import { toolName } from '../spec/derive.js';
import { ambientEnv, readEnv, type EnvRecord } from '../shared/env.js';

/**
 * Where a violation's code comes from.
 *
 * `api` codes are real, documented codes the API answers with — quoting them is
 * useful, because the agent can look them up and they match what a retry would
 * produce. `local` marks a rule the contract states in prose without naming a
 * code; inventing an API-looking code for those would be a lie, so they are
 * labelled as originating here.
 */
export type ViolationOrigin = 'api' | 'local';

export interface GuardrailViolation {
  code: string;
  origin: ViolationOrigin;
  /** JSON path into the request, e.g. `body.lines[0].irpf_rate`. */
  path: string;
  /** What is wrong, with this payload's specifics filled in. */
  message: string;
  /** What to change. */
  fix: string;
}

export class GuardrailError extends Error {
  constructor(readonly violations: GuardrailViolation[]) {
    const anyApi = violations.some((v) => v.origin === 'api');
    super(
      [
        'Blocked by BeeL fiscal guardrails before the request was sent.',
        anyApi
          ? 'The API would have rejected it with the same codes. Fix the payload and retry:'
          : 'Fix the payload and retry:',
        '',
        ...violations.map(
          (v) =>
            `- [${v.code}${v.origin === 'local' ? ', checked locally' : ''}] ${v.path}\n` +
            `  ${v.message}\n` +
            `  Fix: ${v.fix}`,
        ),
      ].join('\n'),
    );
    this.name = 'GuardrailError';
  }
}

/**
 * A violation quoting a documented API error code.
 *
 * `fix` is required rather than borrowed from the error catalogue, and that is
 * the point: the catalogue is deliberately sparse because an API rejection
 * already arrives with the API's own message explaining it. A pre-flight
 * rejection has no such message — this text is everything the agent gets — so
 * each rule states its own, and the two layers stay independent.
 */
function apiViolation(
  code: string,
  path: string,
  message: string,
  fix: string,
): GuardrailViolation {
  return { code, origin: 'api', path, message, fix };
}

/** A violation for a rule the contract states without naming a code. */
function localViolation(
  code: string,
  path: string,
  message: string,
  fix: string,
): GuardrailViolation {
  return { code, origin: 'local', path, message, fix };
}

const PRICING_FIELDS = ['unit_price', 'total_excluding_tax', 'total_including_tax'] as const;

/** The VeriFactu regime key for recargo de equivalencia. */
const SURCHARGE_REGIME_KEY = '18';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

// ── Invoice lines ───────────────────────────────────────────────────────────

function checkLine(
  line: Record<string, unknown>,
  path: string,
  invoiceType: string | undefined,
  out: GuardrailViolation[],
): void {
  // Exactly one pricing field. The schema lists all three as optional because
  // only their combination is invalid, which JSON Schema cannot express here.
  const present = PRICING_FIELDS.filter((f) => line[f] !== undefined && line[f] !== null);
  if (present.length !== 1) {
    out.push(
      apiViolation(
        'LINE_UNIT_PRICE_XOR_DECLARED_TOTAL',
        path,
        present.length === 0
          ? `no pricing field is set; a line needs exactly one of ${PRICING_FIELDS.join(', ')}.`
          : `${present.join(' and ')} are set together; a line takes exactly one.`,
        `Keep exactly one of ${PRICING_FIELDS.join(', ')} on this line and remove the others.`,
      ),
    );
  }

  const declaredTotal = present.find((f) => f !== 'unit_price');
  const discount = asNumber(line.discount_percentage) ?? 0;
  if (declaredTotal && discount > 0) {
    out.push(
      apiViolation(
        'LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT',
        `${path}.discount_percentage`,
        `discount_percentage is ${discount} while ${declaredTotal} is declared; a declared total already contains the discount.`,
        'Remove discount_percentage, or price the line with unit_price and let BeeL apply the discount.',
      ),
    );
  }

  // Omitting irpf_rate inherits the account default, so only an explicit
  // non-zero value is an error — silence here is not consent.
  const irpf = asNumber(line.irpf_rate);
  if (invoiceType === 'SIMPLIFIED' && irpf !== undefined && irpf !== 0) {
    out.push(
      apiViolation(
        'SIMPLIFICADA_FORBIDS_IRPF',
        `${path}.irpf_rate`,
        `irpf_rate is ${irpf} on a SIMPLIFIED (F2) invoice, where AEAT forbids withholding.`,
        'Send irpf_rate: 0 explicitly on this line. Omitting it inherits the account default, which may be non-zero.',
      ),
    );
  }

  // Surcharge and regime 18 imply each other, but only when the regime is
  // explicit: omitted, BeeL derives it from the surcharge.
  const surcharge = asNumber(line.equivalence_surcharge_rate);
  const regimeKey = isRecord(line.main_tax) ? line.main_tax.regime_key : undefined;
  if (typeof regimeKey === 'string') {
    if (regimeKey !== SURCHARGE_REGIME_KEY && (surcharge ?? 0) > 0) {
      out.push(
        apiViolation(
          'SURCHARGE_REQUIRES_REGIME',
          `${path}.equivalence_surcharge_rate`,
          `equivalence_surcharge_rate is ${surcharge} under regime_key "${regimeKey}", which does not admit a surcharge.`,
          'Set main_tax.regime_key to "18", drop the surcharge, or omit regime_key and let BeeL derive it.',
        ),
      );
    }
    if (regimeKey === SURCHARGE_REGIME_KEY && !((surcharge ?? 0) > 0)) {
      out.push(
        apiViolation(
          'REGIME_REQUIRES_SURCHARGE',
          `${path}.main_tax.regime_key`,
          `regime_key "${SURCHARGE_REGIME_KEY}" is recargo de equivalencia, which needs equivalence_surcharge_rate > 0 on the line.`,
          'Set equivalence_surcharge_rate > 0 on this line, or use the regime key that matches the operation.',
        ),
      );
    }
  }

  if (line.line_type === 'SUPLIDO' && !line.source_invoice_reference) {
    out.push(
      localViolation(
        'SUPLIDO_REQUIRES_SOURCE_REFERENCE',
        `${path}.source_invoice_reference`,
        "line_type is SUPLIDO but source_invoice_reference is missing, so the payment made on the client's behalf is untraceable.",
        "Set source_invoice_reference to the third party's invoice reference issued in the client's name.",
      ),
    );
  }

  if (line.exemption_reason_text && line.exemption_reason !== 'OTRO') {
    out.push(
      localViolation(
        'EXEMPTION_TEXT_REQUIRES_OTRO',
        `${path}.exemption_reason_text`,
        `exemption_reason_text is set but exemption_reason is ${String(line.exemption_reason ?? 'absent')}; the text is only read with OTRO, so it would be ignored.`,
        'Set exemption_reason to OTRO, or remove exemption_reason_text.',
      ),
    );
  }
}

function checkInvoice(body: Record<string, unknown>, out: GuardrailViolation[]): void {
  if (body.type === 'CORRECTIVE') {
    out.push(
      localViolation(
        'CORRECTIVE_IS_A_SEPARATE_OPERATION',
        'body.type',
        'type CORRECTIVE is not accepted when creating an invoice.',
        `Create it from the invoice it corrects with ${toolName('createCompanyCorrectiveInvoice')}, ` +
          'declaring rectification_type, rectification_code (R1–R5) and reason there.',
      ),
    );
  }
  const invoiceType = typeof body.type === 'string' ? body.type : undefined;
  if (Array.isArray(body.lines)) {
    body.lines.forEach((line, i) => {
      if (isRecord(line)) checkLine(line, `body.lines[${i}]`, invoiceType, out);
    });
  }
}

// ── Series numbering ────────────────────────────────────────────────────────

const YEAR_TOKEN = /\{YYYY\}|\{YY\}/;
const MONTH_TOKEN = /\{MM\}/;

/**
 * A series format must distinguish the periods its counter resets over, or two
 * invoices would end up with the same number. `ANNUAL` is the default, which is
 * the trap: a format with no year token needs `counter_reset: NEVER` stated.
 */
function checkSeriesBlock(
  series: Record<string, unknown>,
  path: string,
  out: GuardrailViolation[],
): void {
  const format = typeof series.format === 'string' ? series.format : undefined;
  if (format === undefined) return; // omitted → the compliant default applies
  const reset = typeof series.counter_reset === 'string' ? series.counter_reset : 'ANNUAL';

  if (reset === 'MONTHLY' && !(MONTH_TOKEN.test(format) && YEAR_TOKEN.test(format))) {
    out.push(
      apiViolation(
        'SERIES_MONTHLY_REQUIRES_MONTH_AND_YEAR',
        `${path}.format`,
        `counter_reset is MONTHLY but the format "${format}" lacks {MM} and/or a year token, so numbers from different months could collide.`,
        'Add {MM} and a year token ({YYYY} or {YY}) to the format, or change counter_reset.',
      ),
    );
  }
  if (reset === 'ANNUAL' && !YEAR_TOKEN.test(format)) {
    out.push(
      apiViolation(
        'SERIES_ANNUAL_REQUIRES_YEAR',
        `${path}.format`,
        `the format "${format}" has no year token and counter_reset is ANNUAL` +
          `${series.counter_reset === undefined ? ' (the default when omitted)' : ''}, ` +
          'so numbers from different years could collide.',
        'Add a year token ({YYYY} or {YY}) to the format, or set counter_reset: NEVER.',
      ),
    );
  }
}

function checkCompany(body: Record<string, unknown>, out: GuardrailViolation[]): void {
  // Numbering can only be seeded in the call that activates the company; the
  // later activation step does not accept it and would discard it forever.
  if (body.numbering !== undefined && body.activate === false) {
    out.push(
      apiViolation(
        'NUMBERING_REQUIRES_ACTIVATION',
        'body.numbering',
        'a numbering block was sent with activate: false, so it would be discarded and could never be set again.',
        'Drop the numbering block, or set activate: true in the same call.',
      ),
    );
  }
  if (isRecord(body.numbering)) {
    checkSeriesBlock(body.numbering, 'body.numbering', out);
    for (const kind of ['simplified', 'corrective'] as const) {
      const nested = body.numbering[kind];
      if (isRecord(nested)) checkSeriesBlock(nested, `body.numbering.${kind}`, out);
    }
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Which checks apply to which operations.
 *
 * Bound to explicit operationIds rather than matched by pattern: a regex over
 * names is unreadable, and silently stops matching when the API renames things.
 * `tests/guardrail-validate.test.ts` asserts every id here is still a real tool,
 * so a rename fails CI instead of disabling a fiscal check without a trace.
 */
type Check = (body: Record<string, unknown>, out: GuardrailViolation[]) => void;

export const CHECKED_OPERATIONS: Record<string, Check> = {
  // Invoices carry lines, and lines are where most of the fiscal detail lives.
  createCompanyInvoice: checkInvoice,
  patchCompanyInvoice: checkInvoice,
  createCompanyCorrectiveInvoice: checkInvoice,
  createCompanyInvoiceBatch: checkInvoice,
  createCompanyRecurringInvoice: checkInvoice,
  patchCompanyRecurringInvoice: checkInvoice,

  // A company is born with its series, so numbering is validated at creation.
  createCompany: checkCompany,
  patchCompanyById: checkCompany,

  // Series operations carry the format/counter_reset pair directly.
  createCompanySeries: (body, out) => checkSeriesBlock(body, 'body', out),
  patchCompanySeries: (body, out) => checkSeriesBlock(body, 'body', out),
};

/**
 * Every violation in a request body, for the operation it is bound for.
 * Pure and side-effect free; returns all of them rather than the first, so one
 * round trip fixes everything.
 */
export function findViolations(operationId: string, body: unknown): GuardrailViolation[] {
  if (!isRecord(body)) return [];
  const check = CHECKED_OPERATIONS[operationId];
  if (!check) return [];
  const out: GuardrailViolation[] = [];
  check(body, out);
  return out;
}

/** Pre-flight is on unless explicitly disabled. */
function preflightEnabled(env: EnvRecord = ambientEnv()): boolean {
  return readEnv(env, ENV_VAR.disablePreflight) !== '1';
}

/** Throw if the body violates an invariant for this operation. */
export function assertNoViolations(
  operationId: string,
  body: unknown,
  env: EnvRecord = ambientEnv(),
): void {
  if (!preflightEnabled(env)) return;
  const violations = findViolations(operationId, body);
  if (violations.length > 0) throw new GuardrailError(violations);
}
