---
title: Invoice lifecycle & state machine
docPath: /verifactu/submission-states
summary: When an invoice can still be changed, and what to do once it cannot.
---

An invoice is created as a **draft** and can be edited freely. Once **issued** it is
registered, assigned a series and number, and — if the VeriFactu gates are open —
submitted to AEAT. From that moment its fiscal data is immutable: there is no edit, only
voiding or correcting.

## States

`DRAFT` → `ISSUED` → `SENT` → `PAID`, plus `SCHEDULED` (issuance deferred), `OVERDUE`
(past due and unpaid), `VOIDED` (cancelled) and `RECTIFIED` (superseded by a corrective).

## What each state allows

| Operation | Tool | Allowed from |
|---|---|---|
| Edit | `beel_patch_company_invoice` | `DRAFT` only |
| Delete | `beel_delete_company_invoice` | `DRAFT` only |
| Issue | `beel_issue_company_invoice`, or create with `options.issue_directly` | `DRAFT` |
| Schedule | `beel_set_company_invoice_schedule` | `DRAFT` only |
| Mark sent / paid | `beel_set_company_invoice_status` | after issuing |
| Send by email | `beel_send_company_invoice` | after issuing |
| Void | `beel_void_company_invoice` | issued and not already voided |
| Correct | `beel_create_company_corrective_invoice` | issued |

## The rules that matter

- **Issuing assigns the number, and numbers are never reused** — not even after voiding.
- **Voiding is terminal.** It moves the invoice to `VOIDED`, sends a registro de
  anulación to AEAT and burns the number. It cannot be reissued or undone, and calling it
  twice answers `INVOICE_ALREADY_VOIDED` — which means the first call worked.
- **Correcting creates a new invoice** that references the original. The original becomes
  `RECTIFIED` (partial) or `VOIDED` (total). Nothing is ever erased from AEAT.
- **Check before you mutate.** Read the current `status` with
  `beel_get_company_invoice` rather than assuming; an operation the status does not allow
  is rejected with `TRANSITION_NOT_SUPPORTED`.
