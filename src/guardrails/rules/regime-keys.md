---
title: Tax regime keys and cross-field validations
docPath: /verifactu/regime-keys
summary: What regime_key means, where it lives, and which combinations are rejected.
---

`regime_key` declares, per line, which VAT regime the operation falls under. It lives
**inside `main_tax`**, not at the root of the line — a frequent mistake — and takes a
two-character code from a fixed catalogue. Omitted, it defaults to `"01"`, the general
regime.

## The codes you will actually use

| Code | Regime | Note |
|---|---|---|
| `01` | General | The default |
| `02` | Export | Usually paired with `exemption_reason: EXENTA_ART_21` |
| `03` | REBU — used goods, art, antiques | The base is the margin, not the price |
| `07` | Cash basis (criterio de caja) | |
| `17` | OSS / IOSS — EU B2C distance sales | Destination-country VAT applies |
| `18` | Recargo de equivalencia | Per line, never per invoice |
| `20` | Simplified regime | |

The full catalogue has 17 entries; the documentation lists them all.

## Combinations that are rejected

- **`17` (OSS)** requires `exemption_reason: NO_SUJETA_LOCALIZACION` and
  `main_tax.percentage: 0`. Because destination VAT applies, any rate in the EU range
  0–27 % is accepted for this regime regardless of the tax type.
- **`18`** requires `equivalence_surcharge_rate` greater than zero on the line
  (`REGIME_REQUIRES_SURCHARGE`), and a surcharge under any other explicit regime is
  rejected (`SURCHARGE_REQUIRES_REGIME`). Omit `regime_key` and BeeL derives it from the
  surcharge, which is usually the simplest route.

## Rate validation depends on the tax type

IVA accepts only 0, 4, 10 and 21; IGIC 0, 3, 5, 7, 9.5, 15 and 20; IPSI 0.5, 1, 2, 4, 8
and 10. The OSS exception above is the only case where a rate outside its type's list is
accepted.
