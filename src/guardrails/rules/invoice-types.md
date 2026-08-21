---
title: Invoice types F1 / F2 / R1-R5
docPath: /verifactu/invoice-types
summary: How BeeL derives the AEAT invoice type, and the rules each type imposes.
---

You never set the AEAT `tipo_factura` directly. BeeL derives it from the invoice `type`
and, for correctives, from `rectification_code`.

## The types

| You send | AEAT sees | When |
|---|---|---|
| `type: STANDARD` | **F1**, factura ordinaria | B2B, and B2C above the simplified ceiling |
| `type: SIMPLIFIED` | **F2**, factura simplificada | Ticket-style sales, total ≤ 3 000 € |
| A corrective operation | **R1–R5** | Amending an invoice already issued |

**F3** (sustitutiva) is not emitted. To turn an F2 into an F1, issue an R5 `TOTAL`
corrective and then a new `STANDARD` invoice for the same operation.

## F1 — ordinary

Requires `recipient.nif` or `recipient.alternative_id`. When the recipient is an
individual, the `legal_name` must match the AEAT census exactly or the registro is
rejected at submission — check it first with `beel_validate_nif`. See the nif-validation
guardrail.

## F2 — simplified

The recipient is optional, with or without a NIF. Two constraints:

- **Total, VAT included, must not exceed 3 000 €.** Above that it has to be an F1.
- **No IRPF withholding.** AEAT forbids it on F2, and a non-zero `irpf_rate` is rejected
  with `SIMPLIFICADA_FORBIDS_IRPF` rather than coerced to zero. Note that *omitting*
  `irpf_rate` inherits the account default, which may not be zero — send `0` explicitly.

## Correctives are a separate operation, not a type

`type: CORRECTIVE` is **not accepted** when creating an invoice. A corrective is always
created from the invoice it corrects, with `beel_create_company_corrective_invoice`,
which is where `rectification_type`, `rectification_code` and `reason` are declared.

`rectification_code` is the AEAT legal motive:

| Code | Motive |
|---|---|
| `R1` | Error fundado en derecho — the common case |
| `R2` | Concurso de acreedores |
| `R3` | Crédito incobrable (bad debt) |
| `R4` | Resto de causas |
| `R5` | Rectificativa de factura simplificada |

**`R5` is the only code valid for correcting an F2, and R1–R4 are only valid for an F1.**
BeeL enforces the pairing.
