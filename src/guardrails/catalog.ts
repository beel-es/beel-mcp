/**
 * The catalogue of BeeL error codes an agent can actually act on.
 *
 * Every entry answers two questions the raw code does not: **what happened**
 * and **what to do about it**. That pairing is the whole point — an agent that
 * receives `EMISSION_NOT_READY` and nothing else has to guess, and guessing
 * about fiscal operations is how you get a wrong invoice.
 *
 * This is the single source for that knowledge, and it is deliberately used in
 * three places that previously each held their own copy:
 *
 *  - `validate.ts` — pre-flight checks quote the entry of the code they mirror.
 *  - `explain.ts` — every API error the server relays is expanded through it.
 *  - `tools/workflow-tools.ts` — the setup-status report explains its blockers
 *    from here instead of a private map that covered five of them.
 *
 * Entries are transcribed from the OpenAPI contract, which documents both the
 * condition and the remedy. When the contract and this file disagree, the
 * contract wins: `tests/catalog.test.ts` asserts every code here still appears
 * in the spec, so a code the API stops emitting fails CI instead of quietly
 * becoming advice about something that can no longer happen.
 */

/** Who has to act, which is what decides whether an agent can recover alone. */
export type Actor =
  /** The agent can fix this by changing the request and retrying. */
  | 'request'
  /** Account configuration; a human (or an admin call) must change something. */
  | 'configuration'
  /** Nothing is wrong — the operation already happened, or is in flight. */
  | 'benign'
  /** Access or quota; retrying the same call unchanged will not help. */
  | 'access';

export interface CatalogEntry {
  /** What the API is reporting. */
  meaning: string;
  /** The single next action. Phrased as an instruction, not a description. */
  remedy: string;
  /** Who must act — see `Actor`. */
  actor: Actor;
  /** Guardrail whose prose explains the underlying rule, when there is one. */
  guardrail?: string;
  /**
   * Fields inside `error.details` worth surfacing verbatim, because the API
   * puts the specifics there (which scopes are missing, which blockers fired).
   */
  detailKeys?: string[];
}

export const ERROR_CATALOG: Record<string, CatalogEntry> = {
  // ── Issuing readiness ─────────────────────────────────────────────────────
  // Returned as one 422 whose details.blockers[] carries the codes below.
  EMISSION_NOT_READY: {
    meaning: 'The company (NIF) is not ready to issue in this environment.',
    remedy:
      'Read error.details.blockers[] — each entry is a separate code explained in this ' +
      'catalogue — or call beel_get_setup_status for the same list with next actions.',
    actor: 'configuration',
    guardrail: 'verifactu-gates',
    detailKeys: ['blockers'],
  },
  COMPANY_NOT_ACTIVATED: {
    meaning: 'The company exists but has not been switched on for invoicing.',
    remedy: 'Activate the company with beel_activate_company_by_id.',
    actor: 'configuration',
    guardrail: 'verifactu-gates',
  },
  COMPANY_NOT_ACTIVATED_IN_ENVIRONMENT: {
    meaning:
      'The company is activated, but not in the environment this key operates on ' +
      '(Test and Live are activated independently).',
    remedy:
      'Activate it in this environment, or switch to a key for the environment where ' +
      'it is already active.',
    actor: 'configuration',
  },
  ENV_MISMATCH: {
    meaning:
      "The company's configured tax-authority environment does not match the one this " +
      'API key operates on.',
    remedy:
      'Align them: use a key for the same environment, or change the company\'s ' +
      'aeat_environment. Never assume a Test key can issue against production.',
    actor: 'configuration',
    guardrail: 'verifactu-gates',
  },
  NIF_NOT_REGISTERED: {
    meaning: 'The NIF is not registered with AEAT for VeriFactu submission.',
    remedy:
      'Complete the VeriFactu registration for this NIF; inspect the current state with ' +
      'beel_get_company_veri_factu_configuration.',
    actor: 'configuration',
    guardrail: 'verifactu-gates',
  },
  NIF_REPRESENTATION_REQUIRED: {
    meaning:
      'The signed representation document (which authorises BeeL to submit on this ' +
      "NIF's behalf) is missing. Only required in production, where submissions reach " +
      'the real tax authority.',
    remedy: 'Generate it with beel_generate_company_representation, then have it signed.',
    actor: 'configuration',
    guardrail: 'verifactu-gates',
  },
  COMPANY_HAS_NO_NIF: {
    meaning: 'The company record has no NIF, so it cannot issue anything.',
    remedy: 'Set the NIF on the company before attempting to issue.',
    actor: 'configuration',
  },
  NUMBERING_REQUIRES_ACTIVATION: {
    meaning:
      'A numbering block was sent with activate: false. The later activation step does ' +
      'not accept numbering, so it would be discarded forever.',
    remedy: 'Either drop the numbering block, or activate the company in the same call.',
    actor: 'request',
  },

  // ── Series ────────────────────────────────────────────────────────────────
  SERIES_DEFAULT_NOT_FOUND: {
    meaning: 'No default series exists for the document type this operation needs.',
    remedy:
      'Create the missing series (or set a default with beel_set_company_default_series), ' +
      'or pass an explicit series_id. beel_get_company_default_series shows which is missing.',
    actor: 'configuration',
    detailKeys: ['expected_document_type'],
  },
  MISSING_DEFAULT_SERIES: {
    meaning: 'The company has no default series configured for this document type.',
    remedy: 'Set one with beel_set_company_default_series, or pass series_id explicitly.',
    actor: 'configuration',
    detailKeys: ['expected_document_type'],
  },
  SERIES_INCOMPATIBLE_DOC_TYPE: {
    meaning: 'The series_id passed belongs to a series of the wrong document type.',
    remedy:
      'Use a series whose document type matches — error.details.expected_document_type ' +
      'says which was required. Correctives need a corrective series.',
    actor: 'request',
    guardrail: 'series-and-numbering',
    detailKeys: ['expected_document_type'],
  },
  SERIES_MONTHLY_REQUIRES_MONTH_AND_YEAR: {
    meaning:
      'A MONTHLY counter reset needs the format to distinguish months: it must contain ' +
      '{MM} and a year token.',
    remedy: 'Add {MM} and {YYYY} (or {YY}) to the format, or change counter_reset.',
    actor: 'request',
    guardrail: 'series-and-numbering',
  },
  SERIES_ANNUAL_REQUIRES_YEAR: {
    meaning:
      'An ANNUAL counter reset needs a year token ({YYYY} or {YY}) in the format, so ' +
      'numbers from different years cannot collide. ANNUAL is the default when ' +
      'counter_reset is omitted.',
    remedy: 'Add a year token to the format, or set counter_reset: NEVER.',
    actor: 'request',
    guardrail: 'series-and-numbering',
  },
  SERIES_INITIAL_NUMBER_LOCKED_HAS_INVOICES: {
    meaning:
      'The series has already issued an invoice, so its numbering is frozen by law and ' +
      'initial_number can no longer be changed.',
    remedy: 'Create a new series instead. Existing numbering can never be rewritten.',
    actor: 'request',
    guardrail: 'series-and-numbering',
  },

  // ── Invoice lifecycle ─────────────────────────────────────────────────────
  TRANSITION_NOT_SUPPORTED: {
    meaning: "The invoice's current status does not allow this transition.",
    remedy:
      'Read the current status with beel_get_company_invoice and pick the operation ' +
      'that status allows. Issued invoices are amended by voiding or correcting, never edited.',
    actor: 'request',
    guardrail: 'invoice-state-machine',
  },
  INVOICE_ALREADY_VOIDED: {
    meaning:
      'The invoice is already VOIDED. Voiding is not repeatable, so this is almost ' +
      'always a retry of a request that already landed.',
    remedy: 'Treat it as success, not as a failure. Do not attempt to void again.',
    actor: 'benign',
    guardrail: 'cancel-vs-rectify',
  },
  INVOICE_STATUS_NOT_SCHEDULABLE: {
    meaning: 'The invoice is already issued, voided or corrected, so it cannot be scheduled.',
    remedy: 'Only drafts can be scheduled. Check the status first.',
    actor: 'request',
    guardrail: 'invoice-state-machine',
  },
  SCHEDULED_DATE_IN_PAST: {
    meaning: 'scheduled_for is earlier than today.',
    remedy: 'Send a date of today or later. The rejected value is echoed in error.details.',
    actor: 'request',
    detailKeys: ['scheduled_for'],
  },
  INVOICE_DUPLICATE_EXTERNAL_REFERENCE: {
    meaning: 'A live invoice with the same external_ref already exists.',
    remedy:
      'Fetch the existing one by filtering on external_ref before creating another — this ' +
      'usually means the invoice you are about to create is already there.',
    actor: 'request',
  },
  CONVERSION_REQUIRES_PROFORMA: {
    meaning: 'The invoice being converted is not a proforma.',
    remedy: 'Only proformas convert into invoices. Check the type first.',
    actor: 'request',
  },
  PROFORMA_ALREADY_CONVERTED: {
    meaning: 'This proforma has already been converted into an invoice.',
    remedy: 'Fetch the resulting invoice instead of converting again.',
    actor: 'benign',
  },
  PROFORMA_NOT_CONVERTIBLE: {
    meaning: 'The proforma is in a status that cannot be converted.',
    remedy: 'Check its status; a voided or expired proforma cannot become an invoice.',
    actor: 'request',
  },
  CONCURRENT_MODIFICATION: {
    meaning: 'Something else modified this invoice while the request was in flight.',
    remedy: 'Re-read the invoice and reapply the change against its new state.',
    actor: 'request',
  },

  // ── Invoice lines and fiscal data ─────────────────────────────────────────
  // These are also enforced before the request leaves; see validate.ts.
  LINE_UNIT_PRICE_XOR_DECLARED_TOTAL: {
    meaning:
      'A line must carry exactly one of unit_price, total_excluding_tax or ' +
      'total_including_tax.',
    remedy: 'Keep one pricing field per line and remove the others.',
    actor: 'request',
    guardrail: 'invoice-lines',
  },
  LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT: {
    meaning: 'A declared line total already includes any discount, so the two cannot coexist.',
    remedy:
      'Remove discount_percentage, or price the line with unit_price and let BeeL apply ' +
      'the discount.',
    actor: 'request',
    guardrail: 'invoice-lines',
  },
  SIMPLIFICADA_FORBIDS_IRPF: {
    meaning:
      'AEAT forbids IRPF withholding on simplified (F2) invoices. Note that omitting ' +
      'irpf_rate inherits the account default, which may be non-zero.',
    remedy: 'Send irpf_rate: 0 explicitly on every line of an F2 invoice.',
    actor: 'request',
    guardrail: 'invoice-types',
  },
  SURCHARGE_REQUIRES_REGIME: {
    meaning:
      'An equivalence surcharge was sent under a regime key that does not admit one.',
    remedy:
      'Set main_tax.regime_key to "18", drop the surcharge, or omit regime_key entirely ' +
      'and let BeeL derive it from the surcharge.',
    actor: 'request',
    guardrail: 'regime-keys',
  },
  REGIME_REQUIRES_SURCHARGE: {
    meaning:
      'Regime key "18" is recargo de equivalencia, so it needs a surcharge greater than zero.',
    remedy:
      'Set equivalence_surcharge_rate on the line, or use the regime key that matches ' +
      'the operation.',
    actor: 'request',
    guardrail: 'regime-keys',
  },

  // ── Identity ──────────────────────────────────────────────────────────────
  NIF_INVALID: {
    meaning: 'The tax id fails its checksum or format.',
    remedy: 'Validate it with beel_validate_nif before using it on a customer or invoice.',
    actor: 'request',
    guardrail: 'nif-validation',
  },
  NIF_ALREADY_REGISTERED: {
    meaning: 'This NIF is already registered on the account.',
    remedy: 'Fetch the existing company instead of creating a second one.',
    actor: 'benign',
    guardrail: 'multi-nif',
  },
  NIF_PROD_ALREADY_ACTIVE_IN_ANOTHER_ACCOUNT: {
    meaning: 'This NIF is already active in production under a different account.',
    remedy:
      'A NIF can only invoice from one account in production. This needs a human ' +
      'decision about which account owns it.',
    actor: 'configuration',
    guardrail: 'multi-nif',
  },

  // ── Idempotency ───────────────────────────────────────────────────────────
  IDEMPOTENCY_KEY_PROCESSING: {
    meaning: 'A request with this idempotency key is still in flight.',
    remedy:
      'Wait briefly and retry with the SAME key. Using a new key would create a second ' +
      'invoice.',
    actor: 'benign',
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    meaning: 'This idempotency key was already used with a different request body.',
    remedy:
      'Use a new key for a genuinely different request. If the body was not meant to ' +
      'change, you are about to duplicate an invoice — check what already exists first.',
    actor: 'request',
  },
  INVALID_IDEMPOTENCY_KEY: {
    meaning: 'The idempotency key breaks the format rules (alphanumeric, dash, underscore).',
    remedy: 'Send a key matching ^[a-zA-Z0-9_-]+$.',
    actor: 'request',
  },

  // ── Access and quota ──────────────────────────────────────────────────────
  INSUFFICIENT_SCOPE: {
    meaning: 'The credential lacks a scope this operation requires.',
    remedy:
      'error.details.missing_scopes lists them. Reconnect with those scopes granted; ' +
      'retrying unchanged will not help.',
    actor: 'access',
    detailKeys: ['missing_scopes'],
  },
  COMPANY_READ_ONLY: {
    meaning: 'The scope is present, but the role over this company does not allow writing.',
    remedy: 'This needs an access-level change by an account administrator.',
    actor: 'access',
  },
  COMPANY_NOT_ACCESSIBLE: {
    meaning:
      'The company is not reachable with this credential. The same answer is given for a ' +
      'company that does not exist, so existence is never disclosed.',
    remedy: 'Confirm the company id with beel_list_companies.',
    actor: 'access',
  },
  COMPANY_ACCESS_REVOKED: {
    meaning:
      'Access to this NIF was withdrawn while the request was in flight, so the write was ' +
      'rejected and nothing was recorded.',
    remedy: 'Nothing was written. Retrying will not help until access is granted again.',
    actor: 'access',
  },
  LIVE_CREDENTIAL_REQUIRED: {
    meaning:
      'This operation changes something real (members, invitations, account management) ' +
      'and is refused with a Test key.',
    remedy: 'Use a live credential or the dashboard.',
    actor: 'access',
  },
  RATE_LIMIT_EXCEEDED: {
    meaning: 'The rate limit for this endpoint group was exceeded.',
    remedy:
      'Honour the Retry-After header. This server already retries 429s with backoff, so ' +
      'seeing this means the limit is sustained, not momentary.',
    actor: 'benign',
  },
};

/** The catalogue entry for a code, if it has one. */
export function lookupError(code: string | undefined): CatalogEntry | undefined {
  return code ? ERROR_CATALOG[code] : undefined;
}

/** Every code the catalogue covers, sorted. Used by tests and introspection. */
export function catalogCodes(): string[] {
  return Object.keys(ERROR_CATALOG).sort();
}
