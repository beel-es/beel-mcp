/**
 * What this server adds to a BeeL error — and, deliberately, nothing more.
 *
 * The API already answers well. Its `message` explains the problem in the
 * caller's language, `error.details` carries the specifics, and the RFC 7807
 * `type` URI links to a documentation page for that exact code — around 357 of
 * them, maintained alongside the API. Restating any of that here would be
 * maintenance cost that decays into a contradiction.
 *
 * Two things are missing from all of it, and they are the only things in this
 * file:
 *
 *  1. **The remedy as a tool call.** The docs address a human with the dashboard
 *     open ("create a series in settings"). An agent needs the name of the tool
 *     that does it. Translating between the two is this server's job precisely
 *     because the API cannot know its callers are MCP clients.
 *  2. **Whether retrying can help.** Nothing in a response says that a 403 will
 *     keep being a 403 until an administrator acts, or that a 409 means the work
 *     already happened. Without that an agent retries what cannot succeed.
 *
 * So an entry exists only when one of those applies. A code absent from this file
 * is not an oversight: it means the API's own message and doc link say everything
 * worth saying, and `explain.ts` passes them through untouched.
 */

import { BEEL_DEFAULTS } from '../shared/defaults.js';

/** Who has to act, which decides whether an agent can recover on its own. */
export type Actor =
  /** Fixable by changing the request and retrying. */
  | 'request'
  /** Account configuration; a human (or an admin call) must change something. */
  | 'configuration'
  /** Nothing is wrong — the operation already happened, or is in flight. */
  | 'benign'
  /** Access or quota; retrying the same call unchanged will not help. */
  | 'access';

export interface CatalogEntry {
  actor: Actor;
  /**
   * The next action, named as a tool call. Omitted when the API's own message
   * already says it well enough for an agent to follow.
   */
  remedy?: string;
  /** Guardrail whose prose explains the rule behind the code. */
  guardrail?: string;
}

export const ERROR_CATALOG: Record<string, CatalogEntry> = {
  // ── Issuing readiness ─────────────────────────────────────────────────────
  // EMISSION_NOT_READY nests its real reasons in details.blockers[] as bare
  // strings — no message, no link, nothing. They are the strongest case in this
  // file: without an entry they reach the agent as an unexplained token.
  EMISSION_NOT_READY: {
    actor: 'configuration',
    remedy:
      'Work through the blockers listed below, or call beel_get_setup_status for the same ' +
      'list with a next action per NIF.',
    guardrail: 'verifactu-gates',
  },
  COMPANY_NOT_ACTIVATED: {
    actor: 'configuration',
    remedy: 'Activate the company with beel_activate_by_id.',
    guardrail: 'verifactu-gates',
  },
  COMPANY_NOT_ACTIVATED_IN_ENVIRONMENT: {
    actor: 'configuration',
    remedy:
      'Activate it in this environment, or use a credential for the environment where it ' +
      'is already active. Activation is what creates the series and tax configuration.',
  },
  ENV_MISMATCH: {
    actor: 'configuration',
    remedy:
      "Use a credential for the company's environment, or change its aeat_environment. " +
      'A Test credential can never issue against production.',
    guardrail: 'verifactu-gates',
  },
  NIF_NOT_REGISTERED: {
    actor: 'configuration',
    remedy:
      'Inspect the state with beel_get_verifactu_configuration, then complete ' +
      'the AEAT registration for this NIF.',
    guardrail: 'verifactu-gates',
  },
  NIF_REPRESENTATION_REQUIRED: {
    actor: 'configuration',
    remedy:
      'Generate the representation with beel_generate_representation, then have ' +
      'it signed. Only required in production.',
    guardrail: 'verifactu-gates',
  },
  COMPANY_HAS_NO_NIF: { actor: 'configuration' },

  // ── Series ────────────────────────────────────────────────────────────────
  // The API points at the dashboard ("create a series in settings"); these give
  // the tool-call equivalent.
  SERIES_DEFAULT_NOT_FOUND: {
    actor: 'configuration',
    remedy:
      'Set one with beel_set_default_series, or pass an explicit series_id. The ' +
      'details name the document type required.',
    guardrail: 'series-and-numbering',
  },
  MISSING_DEFAULT_SERIES: {
    actor: 'configuration',
    remedy: 'Set one with beel_set_default_series, or pass series_id explicitly.',
    guardrail: 'series-and-numbering',
  },
  SERIES_INCOMPATIBLE_DOC_TYPE: {
    actor: 'request',
    remedy: 'List the available series with beel_list_series and pick a matching one.',
    guardrail: 'series-and-numbering',
  },
  SERIES_MONTHLY_REQUIRES_MONTH_AND_YEAR: {
    actor: 'request',
    guardrail: 'series-and-numbering',
  },
  SERIES_ANNUAL_REQUIRES_YEAR: {
    actor: 'request',
    remedy:
      'Add a year token to the format, or set counter_reset: NEVER. ANNUAL is the default ' +
      'when counter_reset is omitted, which is what makes this easy to hit.',
    guardrail: 'series-and-numbering',
  },
  SERIES_INITIAL_NUMBER_LOCKED_HAS_INVOICES: {
    actor: 'request',
    remedy:
      'Numbering is frozen by law once a series has issued. Create a new series; existing ' +
      'numbering is never rewritten.',
    guardrail: 'series-and-numbering',
  },
  NUMBERING_REQUIRES_ACTIVATION: { actor: 'request', guardrail: 'series-and-numbering' },

  // ── Invoice lifecycle ─────────────────────────────────────────────────────
  TRANSITION_NOT_SUPPORTED: {
    actor: 'request',
    remedy:
      'Read the current status with beel_get_invoice and pick an operation it ' +
      'allows. Issued invoices are amended by voiding or correcting, never edited.',
    guardrail: 'invoice-state-machine',
  },
  INVOICE_ALREADY_VOIDED: {
    actor: 'benign',
    remedy: 'Voiding is not repeatable — treat this as a retry that already landed.',
    guardrail: 'cancel-vs-rectify',
  },
  INVOICE_STATUS_NOT_SCHEDULABLE: { actor: 'request', guardrail: 'invoice-state-machine' },
  INVOICE_DUPLICATE_EXTERNAL_REFERENCE: {
    actor: 'request',
    remedy:
      'Filter beel_list_invoices by external_ref first — this usually means the ' +
      'invoice you are about to create already exists.',
  },
  PROFORMA_ALREADY_CONVERTED: {
    actor: 'benign',
    remedy: 'Conversion is idempotent. Fetch the resulting invoice instead of retrying.',
  },
  CONCURRENT_MODIFICATION: {
    actor: 'benign',
    remedy:
      'Nothing was issued twice and no number was consumed. Re-read the invoice rather ' +
      'than retrying blindly.',
  },

  // ── Invoice lines and fiscal data ─────────────────────────────────────────
  // Also enforced before the request leaves; see validate.ts.
  LINE_UNIT_PRICE_XOR_DECLARED_TOTAL: { actor: 'request', guardrail: 'invoice-lines' },
  LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT: { actor: 'request', guardrail: 'invoice-lines' },
  SIMPLIFICADA_FORBIDS_IRPF: {
    actor: 'request',
    remedy:
      'Send irpf_rate: 0 explicitly on every F2 line — omitting it inherits the account ' +
      'default, which may be non-zero.',
    guardrail: 'invoice-types',
  },
  SURCHARGE_REQUIRES_REGIME: { actor: 'request', guardrail: 'regime-keys' },
  REGIME_REQUIRES_SURCHARGE: { actor: 'request', guardrail: 'regime-keys' },

  // ── Identity ──────────────────────────────────────────────────────────────
  NIF_INVALID: {
    actor: 'request',
    remedy: 'Check it with beel_validate_nif before using it on a customer or invoice.',
    guardrail: 'nif-validation',
  },
  NIF_ALREADY_REGISTERED: {
    actor: 'benign',
    remedy:
      'The existing company_id is in the details — use it instead of creating a second one.',
    guardrail: 'multi-nif',
  },
  NIF_PROD_ALREADY_ACTIVE_IN_ANOTHER_ACCOUNT: {
    actor: 'configuration',
    remedy:
      'A NIF can only invoice from one account in production. This needs a human decision ' +
      'about which account owns it.',
    guardrail: 'multi-nif',
  },

  // ── Idempotency ───────────────────────────────────────────────────────────
  IDEMPOTENCY_KEY_PROCESSING: {
    actor: 'benign',
    remedy: 'Wait briefly and retry with the SAME key. A new key would create a second invoice.',
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    actor: 'request',
    remedy:
      'Use a new key for a genuinely different request. If the body was not meant to change, ' +
      'check what already exists before retrying — you are about to duplicate an invoice.',
  },

  // ── Access and quota ──────────────────────────────────────────────────────
  INSUFFICIENT_SCOPE: { actor: 'access' },
  COMPANY_READ_ONLY: { actor: 'access' },
  COMPANY_ACCESS_REVOKED: {
    actor: 'access',
    remedy: 'Nothing was written. Retrying will not help until access is granted again.',
  },
  COMPANY_NOT_ACCESSIBLE: {
    actor: 'access',
    remedy: 'Confirm the company id with beel_list_companies.',
  },
  LIVE_CREDENTIAL_REQUIRED: { actor: 'access' },
  RATE_LIMIT_EXCEEDED: {
    actor: 'benign',
    remedy:
      'This server already retries 429s honouring Retry-After, so reaching you means the ' +
      'limit is sustained rather than momentary. Slow down instead of retrying harder.',
  },
};

/**
 * The documentation page for a code. The API supplies this as the RFC 7807
 * `type` on every error and that value is preferred; this builds the same URL
 * for codes that arrive without one — nested blockers, chiefly.
 */
export function docsUrlForCode(code: string): string {
  return `${BEEL_DEFAULTS.docsUrl}/errors/${code}`;
}

export function lookupError(code: string | undefined): CatalogEntry | undefined {
  return code ? ERROR_CATALOG[code] : undefined;
}

export function catalogCodes(): string[] {
  return Object.keys(ERROR_CATALOG).sort();
}
