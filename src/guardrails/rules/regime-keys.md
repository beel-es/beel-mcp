`regime_key` lives **inside** `main_tax` (not at the line root) and is a two-char
string from a fixed catalogue. Default is `"01"` (régimen general) if unset.

Common codes: "01" general · "02" exportación · "03" REBU (used goods/art; base = margin)
· "07" criterio de caja · "17" OSS/IOSS (EU B2C distance sales) · "18" recargo de
equivalencia · "20" régimen simplificado. Full catalogue: see the docs page.

Cross-field validations BeeL enforces (will reject the request):
- `regime_key: "17"` (OSS) requires `exemption_reason: NO_SUJETA_LOCALIZACION` and
  `main_tax.percentage: 0`.
- `regime_key: "18"` requires `equivalence_surcharge_rate` on the line.
- `regime_key: "03"` (REBU) with `equivalence_surcharge_rate` → rejected (REBU forbids it).
- `regime_key: "02"` (export) normally pairs with `exemption_reason: EXENTA_ART_21`.

IRPF: on Stripe-generated lines IRPF is always 0. Recargo de equivalencia is per-line,
not per-invoice.
