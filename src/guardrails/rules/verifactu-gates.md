---
title: VeriFactu submission — the three gates
docPath: /verifactu/auto-submit
summary: Why an issued invoice may never reach AEAT, and how to tell before issuing.
---

Issuing an invoice and submitting it to AEAT are not the same act. An issued invoice is
submitted **only when all three gates are open**; otherwise it is issued locally and
carries `verifactu.enabled: false`. It looks successful either way, which is what makes
this worth checking in advance.

## The gates

1. **Auto-submit is on** for the series or integration used.
2. **A VeriFactu configuration exists** — signed representation document, target
   environment, authorised NIFs. Read it with
   `beel_get_verifactu_configuration`, change it with
   `beel_update_verifactu_configuration`.
3. **The configuration's `enabled` flag is on** — the account-wide kill switch.

## Checking before you issue

`beel_get_setup_status` reports, per NIF, whether it can issue and exactly what is
missing. Attempting to issue when it cannot fails with `EMISSION_NOT_READY`, whose
`details.blockers[]` names each reason: `COMPANY_NOT_ACTIVATED`, `ENV_MISMATCH`,
`NIF_NOT_REGISTERED`, `NIF_REPRESENTATION_REQUIRED`.

## Environments

Test credentials submit to AEAT's own test environment — real submissions, flagged as
test. `ENV_MISMATCH` means the company's configured environment and the credential's do
not agree; that is a configuration problem, and no retry will fix it.

## Before issuing in bulk

**Live submissions cannot be undone in batch.** Each one has to be voided or corrected
individually, and each of those is itself a registro sent to AEAT. Turn auto-submit off
*before* issuing a wave you are not certain about, not after.
