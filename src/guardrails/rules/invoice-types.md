You never set the AEAT `tipo_factura` directly. BeeL derives it from the invoice
`type` and, for correctives, from `rectification_code`:

- `type: STANDARD` → **F1** (factura ordinaria). Default for B2B and high-value B2C.
  Requires `recipient.nif` OR `recipient.alternative_id`. If the recipient is an
  individual (NIF starting with a digit), `legal_name` must match the AEAT census or
  the registro is rejected — validate first with `validateNif`.
- `type: SIMPLIFIED` → **F2** (factura simplificada). Recipient optional (with or
  without NIF). Total **IVA included must be ≤ 3 000 €**. F2 also forbids IRPF
  withholding: send `irpf_rate: 0` or omit it, or the line is rejected with
  `SIMPLIFICADA_FORBIDS_IRPF`.
- **F3** (sustitutiva) is not emitted — to upgrade an F2 to F1, issue an R5 TOTAL
  corrective and then a new STANDARD invoice for the same operation.

## Correctives are a separate endpoint, not a `type`

`type: CORRECTIVE` is **NOT accepted** when creating an invoice. A corrective is
always created *from the invoice it corrects*:

    POST /v1/companies/{company_id}/invoices/{invoice_id}/corrective

which is where `rectification_type` and `rectification_code` are declared. All three
of `rectification_type`, `rectification_code` and `reason` are required there.

`rectification_code` maps to the AEAT legal motive **R1–R5**:

- R1 error fundado en derecho (most common) · R2 concurso de acreedores ·
  R3 crédito incobrable (bad debt) · R4 resto de causas · R5 rectificativa de F2.
- **R5 is the ONLY way to correct an F2**; R1–R4 are ONLY for F1. BeeL enforces this.

See the cancel-vs-rectify guardrail for choosing between voiding and correcting.
