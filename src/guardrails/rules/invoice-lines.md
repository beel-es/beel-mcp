---
title: Invoice lines — pricing, discounts and SUPLIDO
docPath: /api-reference/invoices
summary: How a line states its price, and which field combinations are rejected.
---

API usage, not fiscal rules: how to express a line so the request is accepted. The
fiscal rules for lines (rates, exemptions, surcharge, withholding) are in the `taxes`,
`surcharge` and `contents` domains of `beel_rules_list`.

Every line states its price in **exactly one** of three ways. Sending two, or none,
is rejected with `LINE_UNIT_PRICE_XOR_DECLARED_TOTAL`.

| Field | Meaning | Use when |
|---|---|---|
| `unit_price` | Price per unit, before tax. BeeL computes the line total. | The normal case. |
| `total_excluding_tax` | The taxable base **is** this amount, never recomputed. | The total is what you agreed (e.g. 300 units for exactly 1,00 €). |
| `total_including_tax` | What the customer pays: base + IVA + surcharge. | You know the gross figure and want the breakdown worked backwards. |

With `total_including_tax` the engine works backwards from the unrounded base
(`base = total / (1 + iva + recargo)`, per DGT V1919-18) so the rounded parts add up to
the declared total exactly — 100,00 € at 21 % becomes 82,64 + 17,36. IRPF is not part of
that figure: it is a withholding, not price.

## Discounts

`discount_percentage` only applies to `unit_price`. A declared total already contains any
discount, so combining them is rejected with `LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT`.

## Withholding

Omitting `irpf_rate` **inherits the account default**, which may be non-zero. To issue a
line with no withholding you must send `irpf_rate: 0` explicitly. When withholding
applies, and why a simplified invoice never carries it: rules TAX-010 and SIM-003
(`beel_rules_get`).

## SUPLIDO lines

`line_type: SUPLIDO` marks a payment made on behalf of the final client, which is not
part of your taxable base (rule TAX-008). It requires `source_invoice_reference` —
the reference of the third party's invoice issued in the client's name — otherwise the
payment is untraceable and the line is rejected.

## Exemptions

`exemption_reason` takes a code from a fixed catalogue; when a line needs one is rule
CNT-010. `exemption_reason_text` is free
text that is **only** read when the reason is `OTRO`; sending it with any other reason
means the text will be silently ignored, so BeeL rejects it instead.

Quantities may be negative — that is how corrective invoices express a reduction.
