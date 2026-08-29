---
title: Series and invoice numbering
docPath: /api-reference/series
summary: How invoice numbers are formed, and why numbering can never be rewritten.
---

An invoice number is produced by a **series**: a format template plus a counter. A company
is born with three — ordinary (`F`), simplified (`S`) and corrective (`R`) — and every
issued invoice draws its number from one of them.

## The format template

Tokens are **uppercase only** (`{yy}` is rejected) and the template must contain a number
token:

- `{CODIGO}` series code · `{YYYY}` 4-digit year · `{YY}` 2-digit year · `{MM}` month
- `{NUM}` sequential number · `{NUM:4}` the same, zero-padded to 4 digits

`{CODIGO}-{YYYY}-{NUM:4}` produces `FAC-2025-0001`, and is the default.

## The format must match the reset period

The counter resets `NEVER`, `ANNUAL` or `MONTHLY`, and the format has to be able to tell
those periods apart — otherwise two different invoices would get the same number:

| `counter_reset` | The format must contain | Rejected with |
|---|---|---|
| `MONTHLY` | `{MM}` **and** a year token | `SERIES_MONTHLY_REQUIRES_MONTH_AND_YEAR` |
| `ANNUAL` | a year token (`{YYYY}` or `{YY}`) | `SERIES_ANNUAL_REQUIRES_YEAR` |
| `NEVER` | nothing in particular | — |

**`ANNUAL` is the default**, which is the trap: a format like `{CODIGO}-{NUM:6}` carries no
year, so it also needs `counter_reset: NEVER` in the same call.

## Numbering is frozen once used

Once a series issues its first invoice, its numbering is fixed by law. `initial_number`
is then rejected with `SERIES_INITIAL_NUMBER_LOCKED_HAS_INVOICES`. Set it at creation —
that is the moment to continue numbering a business already had elsewhere — or create a
new series. Existing numbers are never rewritten, and a number is never reused, not even
after voiding.

## Choosing a series

Omit `series_id` and the company's default for that document type is used; if there is
none, the request fails with `SERIES_DEFAULT_NOT_FOUND` (an account configuration problem,
not a request problem). Pass `series_id` explicitly and it must match the document type —
a corrective needs a corrective series, or you get `SERIES_INCOMPATIBLE_DOC_TYPE`.

A company's numbering can only be seeded in the call that activates it: a `numbering` block
with `activate: false` is rejected with `NUMBERING_REQUIRES_ACTIVATION`, because the later
activation step does not accept numbering and would discard it forever.
