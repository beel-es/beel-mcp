---
title: Invoice lifecycle & state machine
docPath: /verifactu/submission-states
summary: When an invoice can still be changed, and what to do once it cannot.
---

BeeL invoices move through a strict state machine. An invoice is created as a
DRAFT (or issued directly). Once **issued** it is registered (and, if the VeriFactu
gates are open, submitted to AEAT) and its fiscal data becomes immutable.

States: DRAFT → ISSUED → SENT → PAID. Plus SCHEDULED (issuance deferred),
OVERDUE (past due, unpaid), VOIDED (cancelled), RECTIFIED (corrected by a later invoice).

Transition rules:
- **DRAFT** is the only editable/deletable state. `updateInvoice` and `deleteInvoice`
  work *only* on drafts. After issuance you can never edit fiscal fields — you must
  void or rectify (see the cancel-vs-rectify guardrail).
- **Issue**: `createInvoice` with `issue_directly: true` (or a separate issue step)
  moves DRAFT → ISSUED and assigns the serie+número. Numbers are never reused.
- **mark-sent / sendInvoiceEmail**: ISSUED → SENT.
- **mark-paid**: SENT → PAID.
- **schedule / unschedule / reschedule**: manage SCHEDULED drafts.
- **void**: terminal — moves to VOIDED, sends a registro de anulación to AEAT, and
  burns the serie+número (cannot be reissued).
- **corrective**: issues a *new* invoice that references the original; the original
  becomes RECTIFIED (PARTIAL) or VOIDED (TOTAL). Never erased from AEAT.

Never assume a mutation is possible without checking the invoice's current `status`
first (`getInvoice`). Editing or deleting a non-draft invoice will be rejected.
