---
title: Multi-NIF accounts and company scope
docPath: /api-reference/multi-nif
summary: Which company an operation acts on, and how that is selected.
---

One account can hold several companies, each with its own NIF. Customers, products,
series and invoices all belong to a company — never to the account at large — so every
operation has to say which one it means.

## How the company is chosen

**The `company_id` in the path is the only source of context.** The account that owns it
is derived from it, and no header or credential setting overrides it. List the companies
you can reach with `beel_list_companies`.

> The `BeeL-Active-Company` header and the older `X-Active-Profile` belong to the
> superseded flat endpoints. On the company-scoped operations these tools expose, they
> play no part. Do not reach for them to switch company; pass the right `company_id`.

## Reachability is never disclosed

A `company_id` you cannot reach answers `403 COMPANY_NOT_ACCESSIBLE` — and so does one
that does not exist. That is deliberate: it prevents probing for NIFs in other accounts.
So a 403 here means *check the id you used*, not *this company definitely exists*.

## Activation is per environment

A company is activated for Test and for Live independently, and activation is what
creates its series and tax configuration. A company that exists but is not activated in
the environment your credential belongs to answers
`COMPANY_NOT_ACTIVATED_IN_ENVIRONMENT`.

In production a given NIF can only invoice from one account, so claiming one that is
already live elsewhere fails with `NIF_PROD_ALREADY_ACTIVE_IN_ANOTHER_ACCOUNT` — a
question for a human, not a retry.
