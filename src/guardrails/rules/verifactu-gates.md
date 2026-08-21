An issued invoice is submitted to AEAT only when ALL THREE gates are open;
otherwise it is issued locally with `verifactu.enabled: false`:

1. **Connection/serie auto-submit toggle** is on (per-serie or per-integration override).
2. **A VeriFactu configuration exists** (representation PDF signed, environment target,
   authorised NIFs). Read with `getVeriFactuConfiguration`, set with
   `updateVeriFactuConfiguration`.
3. **The configuration `enabled` flag is on** (account-wide kill switch).

Defaults: Stripe integrations auto-submit ON; manual API issuance uses the serie default.
TEST keys still submit to AEAT's own test environment (real submissions, flagged test).
There is no public "submit now" endpoint — submission happens at issuance.

Warning: LIVE submissions are not batch-undoable. Disable auto-submit *before*
issuing a wave you don't want sent to AEAT.
