---
title: Sheet loads — rehearse first, CSV over JSON
docPath: /automations/loadSheet
summary: Rehearse a load with `dry_run=true` and check `deleted` and `deleted_keys` before a `replace`; CSV takes fewer tokens than JSON.
---

API usage: how to load rows into a sheet without losing the ones already stored.

## Rehearse, then load

A load with `dry_run=true` validates the rows and counts what would change, and stores
nothing. With `mode=replace`, every stored row that is not in the load is removed:
read `deleted` and `deleted_keys` in the rehearsal and send the real load only if they
are the rows you mean to remove. `upsert` never removes rows.

## CSV or JSON

Send the rows as `csv` (text, header row first) or as `rows` (a JSON array of
objects), never both. CSV states each column name once instead of once per row, so the
same load takes far fewer tokens.
