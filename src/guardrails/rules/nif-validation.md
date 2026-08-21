---
title: NIF / DNI validation against the AEAT census
docPath: /nif-validation/validateNif
summary: Why a name that does not match the census makes an invoice unsubmittable.
---

Spanish tax IDs (NIF/CIF/DNI/NIE) are validated against the AEAT census. Use
`validateNif` before creating a customer or issuing an F1 to a Spanish recipient.

Key rule: for an **individual** (NIF starting with a digit), the `legal_name` must
match the AEAT census exactly, or VeriFactu rejects the registro at submission. BeeL
checks this for you, but a mismatch means the invoice cannot be submitted.

Validation is asynchronous and may return VALID / INVALID / PENDING / ERROR. Foreign
customers use `alternative_id` (passport/other) instead of a Spanish NIF; identify them
by country and, for intra-EU B2B, a VAT number.
