## What changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem this solves, or the behaviour it adds. -->

## How it was verified

<!-- Tests added or changed; manual checks against the Test environment if relevant. -->

## Checklist

- [ ] The PR title is a [Conventional Commit](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `docs:` …) — it becomes the CHANGELOG entry.
- [ ] `npm test`, `npm run typecheck` and `npm run lint` pass locally.
- [ ] `npm run format` has been run.
- [ ] No literal operation ids, tool names, scopes or error codes were hardcoded — they come from the contract (see CONTRIBUTING.md).
- [ ] Comments explain invariants, not history.
- [ ] The body names no secret names, providers, account ids, incidents, private repositories or session URLs (this repository is public; see AGENTS.md).
