---
title: NIF / DNI validation against the AEAT census
docPath: /nif-validation/validateNif
summary: Why a name that does not match the census makes an invoice unsubmittable.
---

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

`beel_validate_nif` answers `VALID`, `INVALID`, `PENDING` or `ERROR`. `PENDING` is not a
failure — the census has not answered yet — and it is not a reason to issue anyway.

## Foreign recipients

A recipient without a Spanish tax id uses `alternative_id` (passport or other document)
together with their country. For intra-EU B2B, the VAT number identifies them. Census
matching does not apply, so the name requirement above does not either.
