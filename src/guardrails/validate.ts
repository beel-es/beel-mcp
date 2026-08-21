/**
 * Executable guardrails — the pre-flight checks that run BEFORE a mutating call
 * reaches the API.
 *
 * Scope is deliberate and narrow. A rule belongs here only if it is:
 *
 *  1. a cross-field invariant the operation's JSON Schema cannot express (the
 *     schema already rejects missing required fields and bad enums — repeating
 *     that here would only add a second place to keep in sync), and
 *  2. documented in the OpenAPI spec as a rejection with a named error code.
 *
 * That second condition is what makes this safe: every rule is a strict subset of
 * what the API itself rejects, so a pre-flight failure is a verdict the call was
 * going to receive anyway — delivered earlier, cheaper, and with the fix attached.
 * It can never make the server permissive, only faster to correct.
 *
 * The prose guardrails in `rules/*.md` describe many more invariants. Those stay
 * advisory on purpose: rules the backend owns (AEAT census matching, the 3 000 €
 * F2 ceiling computed over server-side totals, VeriFactu gates) depend on state
 * this process does not have, and guessing them here would reject valid invoices.
 */

import { ENV_VAR } from '../shared/defaults.js';
import { ambientEnv, readEnv, type EnvRecord } from '../shared/env.js';

/** A single failed invariant, phrased so the agent can repair the payload itself. */
export interface GuardrailViolation {
  /** The error code the API would answer with, for traceability. */
  code: string;
  /** JSON path into the request body, e.g. `lines[0].irpf_rate`. */
  path: string;
  /** What is wrong. */
  message: string;
  /** What to change. */
  fix: string;
}

export class GuardrailError extends Error {
  constructor(readonly violations: GuardrailViolation[]) {
    super(
      [
        'Request blocked by BeeL fiscal guardrails before it reached the API.',
        'The API would have rejected it with the same codes; fix the payload and retry:',
        '',
        ...violations.map((v) => `- [${v.code}] ${v.path}: ${v.message}\n  Fix: ${v.fix}`),
      ].join('\n'),
    );
    this.name = 'GuardrailError';
  }
}

const PRICING_FIELDS = ['unit_price', 'total_excluding_tax', 'total_including_tax'] as const;

/** The regime key that equivalence surcharge belongs to (VeriFactu catalogue). */
const SURCHARGE_REGIME_KEY = '18';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Invariants that hold for a single invoice line. */
function checkLine(
  line: Record<string, unknown>,
  path: string,
  invoiceType: string | undefined,
  violations: GuardrailViolation[],
): void {
  // Exactly one pricing field per line — the schema lists all three as optional
  // because only their combination is invalid, which JSON Schema cannot say here.
  const present = PRICING_FIELDS.filter((f) => line[f] !== undefined && line[f] !== null);
  if (present.length !== 1) {
    violations.push({
      code: 'LINE_UNIT_PRICE_XOR_DECLARED_TOTAL',
      path,
      message:
        present.length === 0
          ? `no pricing field set; a line needs exactly one of ${PRICING_FIELDS.join(', ')}.`
          : `${present.join(' and ')} are set together; a line takes exactly one of ${PRICING_FIELDS.join(', ')}.`,
      fix: `Keep exactly one of ${PRICING_FIELDS.join(', ')} on this line and remove the others.`,
    });
  }

  // A declared total already includes any discount, so the two cannot coexist.
  const declaredTotal = present.find((f) => f !== 'unit_price');
  const discount = asNumber(line.discount_percentage) ?? 0;
  if (declaredTotal && discount > 0) {
    violations.push({
      code: 'LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT',
      path: `${path}.discount_percentage`,
      message: `discount_percentage is ${discount} while ${declaredTotal} is declared; a declared total already contains the discount.`,
      fix: `Remove discount_percentage, or switch the line to unit_price and let BeeL apply the discount.`,
    });
  }

  // AEAT forbids IRPF withholding on simplified (F2) invoices. Omitting the field
  // inherits the account default, so only an explicit non-zero value is an error.
  const irpf = asNumber(line.irpf_rate);
  if (invoiceType === 'SIMPLIFIED' && irpf !== undefined && irpf !== 0) {
    violations.push({
      code: 'SIMPLIFICADA_FORBIDS_IRPF',
      path: `${path}.irpf_rate`,
      message: `irpf_rate is ${irpf} on a SIMPLIFIED (F2) invoice, where AEAT forbids withholding.`,
      fix: 'Send irpf_rate: 0 on F2 lines (omitting it inherits the account default, which may be non-zero).',
    });
  }

  // Equivalence surcharge and regime 18 imply each other, but only when the
  // regime is explicit — omitted, BeeL derives it from the surcharge.
  const surcharge = asNumber(line.equivalence_surcharge_rate);
  const regimeKey = isRecord(line.main_tax) ? line.main_tax.regime_key : undefined;
  if (typeof regimeKey === 'string') {
    if (regimeKey !== SURCHARGE_REGIME_KEY && (surcharge ?? 0) > 0) {
      violations.push({
        code: 'SURCHARGE_REQUIRES_REGIME',
        path: `${path}.equivalence_surcharge_rate`,
        message: `equivalence_surcharge_rate is ${surcharge} under regime_key "${regimeKey}", which does not admit a surcharge.`,
        fix: `Set main_tax.regime_key to "${SURCHARGE_REGIME_KEY}", drop the surcharge, or omit regime_key and let BeeL derive it.`,
      });
    }
    if (regimeKey === SURCHARGE_REGIME_KEY && !((surcharge ?? 0) > 0)) {
      violations.push({
        code: 'REGIME_REQUIRES_SURCHARGE',
        path: `${path}.main_tax.regime_key`,
        message: `regime_key "${SURCHARGE_REGIME_KEY}" (recargo de equivalencia) needs equivalence_surcharge_rate > 0 on the line.`,
        fix: 'Set equivalence_surcharge_rate on this line, or use a regime key that matches the operation.',
      });
    }
  }

  // A SUPLIDO line is a payment made on behalf of the client; without the source
  // reference it is not traceable and the API rejects it.
  if (line.line_type === 'SUPLIDO' && !line.source_invoice_reference) {
    violations.push({
      code: 'SUPLIDO_REQUIRES_SOURCE_REFERENCE',
      path: `${path}.source_invoice_reference`,
      message: 'line_type is SUPLIDO but source_invoice_reference is missing.',
      fix: "Set source_invoice_reference to the third party's invoice reference issued in the client's name.",
    });
  }

  // Free-text exemption wording only means anything under the OTRO reason.
  if (line.exemption_reason_text && line.exemption_reason !== 'OTRO') {
    violations.push({
      code: 'EXEMPTION_TEXT_REQUIRES_OTRO',
      path: `${path}.exemption_reason_text`,
      message: `exemption_reason_text is set but exemption_reason is ${String(line.exemption_reason ?? 'absent')}; the text is only used with OTRO.`,
      fix: 'Set exemption_reason to OTRO, or remove exemption_reason_text.',
    });
  }
}

/**
 * Check a request body against the invariants above. Pure and side-effect free;
 * returns every violation rather than the first, so one round trip fixes them all.
 */
export function findViolations(body: unknown): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  if (!isRecord(body)) return violations;

  const invoiceType = typeof body.type === 'string' ? body.type : undefined;

  // Correctives are created from the invoice they correct, never by `type`.
  if (invoiceType === 'CORRECTIVE') {
    violations.push({
      code: 'CORRECTIVE_IS_A_SEPARATE_OPERATION',
      path: 'type',
      message: 'type CORRECTIVE is not accepted when creating an invoice.',
      fix:
        'Create the corrective from the invoice it corrects with ' +
        'beel_create_company_corrective_invoice, declaring rectification_type, ' +
        'rectification_code (R1–R5) and reason there.',
    });
  }

  if (Array.isArray(body.lines)) {
    body.lines.forEach((line, index) => {
      if (isRecord(line)) checkLine(line, `lines[${index}]`, invoiceType, violations);
    });
  }

  return violations;
}

/** Pre-flight is on unless explicitly disabled, which is logged as an escape hatch. */
export function preflightEnabled(env: EnvRecord = ambientEnv()): boolean {
  return readEnv(env, ENV_VAR.disablePreflight) !== '1';
}

/**
 * Throw if the body violates an invariant. The caller runs this immediately before
 * the HTTP request, so a blocked call never consumes an idempotency key.
 */
export function assertNoViolations(body: unknown, env: EnvRecord = ambientEnv()): void {
  if (!preflightEnabled(env)) return;
  const violations = findViolations(body);
  if (violations.length > 0) throw new GuardrailError(violations);
}
