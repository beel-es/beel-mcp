An account can hold several companies (NIFs). When operating on behalf of a
specific company, pass its UUID. With the MCP server set the `BEEL_ACTIVE_COMPANY`
environment variable (or the per-call `active_company` argument where exposed) — it is
sent as the `Beel-Active-Company` header. List your companies with `listCompanies`.
Customers, series and invoices are scoped to the active company. The legacy
`X-Active-Profile` header is deprecated; use `Beel-Active-Company`.
