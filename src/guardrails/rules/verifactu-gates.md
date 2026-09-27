---
title: Issuing readiness and VeriFactu configuration
docPath: /verifactu/auto-submit
summary: How to tell, before issuing, whether a NIF can issue, and what each blocker means.
---

API usage: how to check that a company can issue and read what is missing. The fiscal
rules on billing records and their submission to AEAT are the `records` domain of
`beel_rules_list` — REC-002 (the record goes to AEAT as soon as the invoice is issued) and
REC-011 (the NIF holder signs the AEAT representation first) in particular.

## The configuration

Read it with `beel_get_verifactu_configuration`, change it with
`beel_update_verifactu_configuration`. The update carries two flags: `enabled` (whether
VeriFactu is enabled) and `apply_by_default` (whether it is applied to new invoices, which
requires `enabled`).

## Checking before you issue

`beel_get_setup_status` reports, per NIF, whether it can issue and exactly what is
missing. Attempting to issue when it cannot fails with `EMISSION_NOT_READY`, whose
`details.blockers[]` names each reason: `COMPANY_HAS_NO_NIF`, `SERIES_DEFAULT_NOT_FOUND`,
`COMPANY_NOT_ACTIVATED`, `ENV_MISMATCH`, `NIF_NOT_REGISTERED`,
`NIF_REPRESENTATION_REQUIRED`. The first two are operational — a NIF and a default series
are needed to issue at all, VeriFactu or not; the rest are the VeriFactu capability chain,
reported one at a time and in order.

## Environments

Test credentials submit to AEAT's own test environment — real submissions, flagged as
test. `ENV_MISMATCH` means the company's configured environment and the credential's do
not agree; that is a configuration problem, and no retry will fix it. Never test with a
production key: rule LIF-003.
