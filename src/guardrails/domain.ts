/**
 * Domain guardrails — the fiscal invariants that a blindly auto-generated MCP
 * would miss. These are distilled from the BeeL docs (docs.beel.es) and exposed
 * to agents as MCP resources, and woven into tool descriptions (see enrich.ts).
 *
 * They are intentionally concise: the canonical, exhaustive version lives in the
 * docs and is reachable at runtime via the `beel_docs_search` / `beel_docs_get`
 * tools. Each guardrail points at its source page so an agent can drill in.
 */

export interface GuardrailDoc {
  /** Stable id, also the last segment of the resource URI. */
  id: string;
  title: string;
  /** Path on docs.beel.es for the full version. */
  docPath: string;
  /** Markdown body surfaced to the agent. */
  body: string;
}

export const GUARDRAIL_URI_PREFIX = 'beel://guardrails/';

export function guardrailUri(id: string): string {
  return GUARDRAIL_URI_PREFIX + id;
}

export const GUARDRAILS: GuardrailDoc[] = [
  {
    id: 'invoice-state-machine',
    title: 'Invoice lifecycle & state machine',
    docPath: '/verifactu/submission-states',
    body: `BeeL invoices move through a strict state machine. An invoice is created as a
DRAFT (or issued directly). Once **issued** it is registered (and, if the VeriFactu
gates are open, submitted to AEAT) and its fiscal data becomes immutable.

States: DRAFT → ISSUED → SENT → PAID. Plus SCHEDULED (issuance deferred),
OVERDUE (past due, unpaid), VOIDED (cancelled), RECTIFIED (corrected by a later invoice).

Transition rules:
- **DRAFT** is the only editable/deletable state. \`updateInvoice\` and \`deleteInvoice\`
  work *only* on drafts. After issuance you can never edit fiscal fields — you must
  void or rectify (see the cancel-vs-rectify guardrail).
- **Issue**: \`createInvoice\` with \`issue_directly: true\` (or a separate issue step)
  moves DRAFT → ISSUED and assigns the serie+número. Numbers are never reused.
- **mark-sent / sendInvoiceEmail**: ISSUED → SENT.
- **mark-paid**: SENT → PAID.
- **schedule / unschedule / reschedule**: manage SCHEDULED drafts.
- **void**: terminal — moves to VOIDED, sends a registro de anulación to AEAT, and
  burns the serie+número (cannot be reissued).
- **corrective**: issues a *new* invoice that references the original; the original
  becomes RECTIFIED (PARTIAL) or VOIDED (TOTAL). Never erased from AEAT.

Never assume a mutation is possible without checking the invoice's current \`status\`
first (\`getInvoice\`). Editing or deleting a non-draft invoice will be rejected.`,
  },
  {
    id: 'cancel-vs-rectify',
    title: 'Cancel (void) vs amend (rectificativa)',
    docPath: '/verifactu/cancel-and-fix',
    body: `Choosing wrong here misreports to AEAT. The 30-second decision:

- The invoice **should never have existed** (wrong customer billed, accidental
  duplicate) → **ANULACIÓN**: \`voidInvoice\` (POST /invoices/{id}/void). Terminal,
  burns the número. Anulación does NOT fix errors.
- The invoice **should exist but data is wrong** (amount, IVA rate, NIF, name,
  post-issue discount, bad debt) → **RECTIFICATIVA**: \`createCompanyCorrectiveInvoice\`.
- A previous registro was **rejected by AEAT for a non-fiscal reason** (typo in a
  description) → **subsanación**, which BeeL retries automatically. No public endpoint.

Corrective carries three fields:
- \`rectification_code\` (R1–R5) = the AEAT legal *motive* (why).
- \`rectification_type\` = PARTIAL (delta lines, required) or TOTAL (replace; omit lines).
- \`reason\` = free-text human description (required).

A TOTAL corrective on an already-VOIDED original is rejected (chain closed).`,
  },
  {
    id: 'invoice-types',
    title: 'Invoice types F1 / F2 / R1–R5 and how BeeL derives the AEAT code',
    docPath: '/verifactu/invoice-types',
    body: `You never set the AEAT \`tipo_factura\` directly. BeeL derives it from \`type\` and,
for correctives, \`rectification_code\`:

- \`type: STANDARD\` → **F1** (factura ordinaria). Default for B2B and high-value B2C.
  Requires \`recipient.nif\` OR \`recipient.alternative_id\`. If the recipient is an
  individual (NIF starting with a digit), \`legal_name\` must match the AEAT census or
  the registro is rejected — validate first with \`validateNif\`.
- \`type: SIMPLIFIED\` → **F2** (factura simplificada). Recipient optional. Total
  (IVA included) **must be ≤ 3 000 €** — rejected above the threshold.
- \`type: CORRECTIVE\` + \`rectification_code\` → **R1–R5**:
  - R1 error fundado en derecho (most common) · R2 concurso de acreedores ·
    R3 crédito incobrable (bad debt) · R4 resto de causas · R5 rectificativa de F2.
  - **R5 is the ONLY way to correct an F2**; R1–R4 are ONLY for F1. BeeL enforces this.

F3 (sustitutiva) is not emitted — to upgrade an F2 to F1, issue an R5 TOTAL then a new
STANDARD invoice for the same operation.`,
  },
  {
    id: 'regime-keys',
    title: 'Tax regime keys (main_tax.regime_key) and cross-field validations',
    docPath: '/verifactu/regime-keys',
    body: `\`regime_key\` lives **inside** \`main_tax\` (not at the line root) and is a two-char
string from a fixed catalogue. Default is \`"01"\` (régimen general) if unset.

Common codes: "01" general · "02" exportación · "03" REBU (used goods/art; base = margin)
· "07" criterio de caja · "17" OSS/IOSS (EU B2C distance sales) · "18" recargo de
equivalencia · "20" régimen simplificado. Full catalogue: see the docs page.

Cross-field validations BeeL enforces (will reject the request):
- \`regime_key: "17"\` (OSS) requires \`exemption_reason: NO_SUJETA_LOCALIZACION\` and
  \`main_tax.percentage: 0\`.
- \`regime_key: "18"\` requires \`equivalence_surcharge_rate\` on the line.
- \`regime_key: "03"\` (REBU) with \`equivalence_surcharge_rate\` → rejected (REBU forbids it).
- \`regime_key: "02"\` (export) normally pairs with \`exemption_reason: EXENTA_ART_21\`.

IRPF: on Stripe-generated lines IRPF is always 0. Recargo de equivalencia is per-line,
not per-invoice.`,
  },
  {
    id: 'nif-validation',
    title: 'NIF / DNI validation against the AEAT census',
    docPath: '/nif-validation/validateNif',
    body: `Spanish tax IDs (NIF/CIF/DNI/NIE) are validated against the AEAT census. Use
\`validateNif\` before creating a customer or issuing an F1 to a Spanish recipient.

Key rule: for an **individual** (NIF starting with a digit), the \`legal_name\` must
match the AEAT census exactly, or VeriFactu rejects the registro at submission. BeeL
checks this for you, but a mismatch means the invoice cannot be submitted.

Validation is asynchronous and may return VALID / INVALID / PENDING / ERROR. Foreign
customers use \`alternative_id\` (passport/other) instead of a Spanish NIF; identify them
by country and, for intra-EU B2B, a VAT number.`,
  },
  {
    id: 'verifactu-gates',
    title: 'VeriFactu submission — the three gates',
    docPath: '/verifactu/auto-submit',
    body: `An issued invoice is submitted to AEAT only when ALL THREE gates are open;
otherwise it is issued locally with \`verifactu.enabled: false\`:

1. **Connection/serie auto-submit toggle** is on (per-serie or per-integration override).
2. **A VeriFactu configuration exists** (representation PDF signed, environment target,
   authorised NIFs). Read with \`getVeriFactuConfiguration\`, set with
   \`updateVeriFactuConfiguration\`.
3. **The configuration \`enabled\` flag is on** (account-wide kill switch).

Defaults: Stripe integrations auto-submit ON; manual API issuance uses the serie default.
Sandbox keys still submit to AEAT's *sandbox* (real submissions, flagged test).
There is no public "submit now" endpoint — submission happens at issuance.

Warning: production submissions are not batch-undoable. Disable auto-submit *before*
issuing a wave you don't want sent to AEAT.`,
  },
  {
    id: 'multi-nif',
    title: 'Multi-NIF accounts and the Beel-Active-Company header',
    docPath: '/api-reference/multi-nif',
    body: `An account can hold several companies (NIFs). When operating on behalf of a
specific company, pass its UUID. With the MCP server set the \`BEEL_ACTIVE_COMPANY\`
environment variable (or the per-call \`active_company\` argument where exposed) — it is
sent as the \`Beel-Active-Company\` header. List your companies with \`listCompanies\`.
Customers, series and invoices are scoped to the active company. The legacy
\`X-Active-Profile\` header is deprecated; use \`Beel-Active-Company\`.`,
  },
];

export function findGuardrail(id: string): GuardrailDoc | undefined {
  return GUARDRAILS.find((g) => g.id === id);
}
