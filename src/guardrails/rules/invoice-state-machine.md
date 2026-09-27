---
title: Invoice and proforma states, and the tool for each operation
docPath: /verifactu/submission-states
summary: The status names, the proforma lifecycle, and which tool performs each operation.
---

This guide names the states and the tools. **When** each operation is allowed is fiscal
rule, not API usage: read it with `beel_rules_list` (domain `lifecycle`, `void`,
`corrective`) — in particular LIF-001 (an issued invoice is never edited or deleted),
LIF-002 (only a draft can be issued), VOI-002 (void an issued invoice; delete a draft)
and COR-001 (which statuses a corrective accepts).

## States

`DRAFT` → `ISSUED` → `SENT` → `PAID`, plus `SCHEDULED` (issuance deferred), `OVERDUE`
(past due and unpaid), `VOIDED` (cancelled) and `RECTIFIED` (superseded by a corrective).

A proforma is not an invoice and does not walk that path. It is born `ACTIVE`, numbered
and editable, and leaves in one of three ways: `CONVERTED` (turned into an invoice, which
is terminal — the proforma survives as the record of the accepted quote), `VOIDED` (the
offer was rejected or withdrawn) or `EXPIRED` (its `valid_until` has passed).

## The tool for each operation

| Operation | Tool |
|---|---|
| Edit | `beel_patch_invoice` |
| Delete | `beel_delete_invoice` |
| Issue | `beel_issue_invoice`, or create with `options.issue_directly` |
| Schedule | `beel_set_invoice_schedule` |
| Mark sent / paid | `beel_set_invoice_status` |
| Send by email | `beel_send_invoice` |
| Void | `beel_void_invoice` |
| Correct | `beel_create_corrective_invoice` |

## Check before you mutate

Read the current `status` with `beel_get_invoice` rather than assuming; an operation the
status does not allow is rejected with `TRANSITION_NOT_SUPPORTED`. Calling
`beel_void_invoice` twice answers `INVOICE_ALREADY_VOIDED`, which means the first call
worked.
