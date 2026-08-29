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
operation did happen and you merely described it wrongly, voiding misreports it.

## What a corrective declares

Three fields, all required:

- **`rectification_code`** — the AEAT legal motive, R1 to R5. See the invoice-types
  guardrail; R5 is the only code valid for a simplified (F2) invoice.
- **`rectification_type`** — `PARTIAL` (send only the delta lines) or `TOTAL` (replaces
  the original; omit lines entirely).
- **`reason`** — free text describing the correction for a human reader.

A `TOTAL` corrective against an already-voided original is rejected: that chain is closed.

## Choosing the series

Correctives draw their number from a **corrective** series, never from the original's.
Omit `series_id` to use the company default — if there is none the call fails with
`SERIES_DEFAULT_NOT_FOUND`, which is an account configuration problem, not a request one.
