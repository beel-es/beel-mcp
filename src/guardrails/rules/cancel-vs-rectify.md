---
title: Void vs amend (rectificativa)
docPath: /verifactu/cancel-and-fix
summary: Choosing wrong here misreports to AEAT. The 30-second decision.
---

Both operations are irreversible and they report different things to the tax authority.
Getting this wrong is not a UX problem, it is a misdeclaration.

## The decision

| The situation | What it is | What to call |
|---|---|---|
| The invoice **should never have existed** — wrong customer billed, accidental duplicate | **Anulación** | `beel_void_invoice` |
| The invoice **should exist but its data is wrong** — amount, IVA rate, NIF, name, post-issue discount, bad debt | **Rectificativa** | `beel_create_corrective_invoice` |
| A registro was **rejected by AEAT for a non-fiscal reason** — a typo in a description | **Subsanación** | Nothing: BeeL retries automatically. There is no public endpoint |

**Voiding does not fix errors.** It states that the operation never happened. If the
operation did happen and you merely described it wrongly, voiding misreports it. The one
exception is a withholding that should not have been applied: it is not a cause for a
corrective, so void the invoice and issue a new one without it.

## When a void is refused

- **Sent or paid:** delivering or collecting an invoice suggests the operation was real,
  so the void must confirm it was not with `issued_in_error: true`. Without it the call
  fails with `VOID_REQUIRES_ISSUED_IN_ERROR`. Only send it when it is true.
- **Already corrected:** an invoice with live correctives cannot be voided
  (`INVOICE_HAS_LIVE_CORRECTIVES`); issue another corrective. A `TOTAL` corrective cannot
  be voided either (`TOTAL_CORRECTIVE_NOT_VOIDABLE`).
- **An exchange invoice** (the full invoice that replaced simplified ones) cannot be voided
  (`EXCHANGE_INVOICE_NOT_VOIDABLE`); correct it instead.

## What a corrective declares

Three fields, all required:

- **`rectification_code`** — the AEAT legal motive, R1 to R5. See the invoice-types
  guardrail; R5 is the only code valid for a simplified (F2) invoice.
- **`rectification_type`** — `PARTIAL` (send only the delta lines) or `TOTAL` (rectifies
  everything still invoiced on the original, its live correctives included; sending
  `lines` fails with `RECTIFICATIVA_TOTAL_CON_LINEAS`).
- **`reason`** — free text describing the correction for a human reader.

A `TOTAL` corrective against an already-voided original is rejected: that chain is closed.

A corrective must be issued within four years (`CORRECTIVE_OUT_OF_TIME`). For a cause of
article 80 of the VAT Act (a later discount, a cancelled operation, a price change,
insolvency, a bad debt) send `circumstance_date` and the four years count from it; it is
accepted with R1, R2, R3 and R5, never with R4
(`CORRECTIVE_CIRCUMSTANCE_DATE_NOT_APPLICABLE`).

## Choosing the series

Correctives draw their number from a **corrective** series, never from the original's.
Omit `series_id` to use the company default — if there is none the call fails with
`SERIES_DEFAULT_NOT_FOUND`, which is an account configuration problem, not a request one.
