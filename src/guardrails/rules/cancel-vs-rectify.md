---
title: Void vs amend (rectificativa)
docPath: /verifactu/cancel-and-fix
summary: Choosing wrong here misreports to AEAT. The 30-second decision.
---

Choosing wrong here misreports to AEAT. The 30-second decision:

- The invoice **should never have existed** (wrong customer billed, accidental
  duplicate) → **ANULACIÓN**: `voidInvoice` (POST /invoices/{id}/void). Terminal,
  burns the número. Anulación does NOT fix errors.
- The invoice **should exist but data is wrong** (amount, IVA rate, NIF, name,
  post-issue discount, bad debt) → **RECTIFICATIVA**: `createCompanyCorrectiveInvoice`.
- A previous registro was **rejected by AEAT for a non-fiscal reason** (typo in a
  description) → **subsanación**, which BeeL retries automatically. No public endpoint.

Corrective carries three fields:
- `rectification_code` (R1–R5) = the AEAT legal *motive* (why).
- `rectification_type` = PARTIAL (delta lines, required) or TOTAL (replace; omit lines).
- `reason` = free-text human description (required).

A TOTAL corrective on an already-VOIDED original is rejected (chain closed).
