---
title: NIF / DNI validation against the AEAT census
docPath: /nif-validation/validateNif
summary: Why a name that does not match the census makes an invoice unsubmittable.
---

API usage: how to run the census check and read its answer. The rules that require it
are CNT-020 (a Spanish recipient's NIF is in the AEAT census) and CNT-021 (a recipient
without a Spanish NIF is identified by an alternative id).

Spanish tax ids (NIF, CIF, DNI, NIE) are checked against the AEAT census, not merely
against a checksum. Use `beel_validate_nif` before creating a customer or issuing an
ordinary (F1) invoice to a Spanish recipient.

## The rule that catches people out

For an **individual** — a NIF beginning with a digit — the `legal_name` must match the
AEAT census **exactly**. A name that is merely recognisable to a human is rejected at
submission, and by then the invoice is already issued: it exists, it holds a number, and
it cannot reach AEAT until the mismatch is resolved.

Validating first turns that into a cheap failure before anything is issued.

## Validation is asynchronous

`beel_validate_nif` answers `VALID`, `INVALID`, `PENDING` or `ERROR` — the four members of
the contract's `NifValidationStatus`. `PENDING` (not asked yet, or the census is
unavailable) and `ERROR` (a technical failure after retries) are both "no answer", not
"no": neither is a reason to issue anyway.

`valid: false` covers more than "not in the census". A **deregistered** NIF cannot issue
but can still receive an invoice; a **revoked** one cannot operate on either side. Read
`census_status` to tell them apart, since they are not fixed the same way.

## Foreign recipients

A recipient without a Spanish tax id uses `alternative_id` (passport or other document)
together with their country. Census matching does not apply, so the name requirement
above does not either.

For intra-EU B2B the EU VAT number identifies them: `type: NIF_IVA` (02), only for an EU
member state other than Spain (`ALTERNATIVE_ID_VAT_REQUIRES_EU_COUNTRY`), and `number`
with that country's VAT structure, prefix included — `FR40303265045`, `EL094014201` for
Greece (`ALTERNATIVE_ID_VAT_INVALID_FORMAT`). A customer from outside the EU uses another
type, such as `OTHER_DOCUMENT` or `COUNTRY_ID`. Well-formed is not registered: a number
missing from VIES is still rejected by VeriFactu after the invoice is issued.
