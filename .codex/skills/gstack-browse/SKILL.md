---
name: gstack-browse
description: Use gstack's compiled browser engine for browsing, UI verification, screenshots, and dogfooding flows.
---

# gstack-browse

Use this skill when the user says `/browse` or asks to browse a site, click through a flow, capture screenshots, verify UI behavior, or dogfood a web app with gstack's browser engine.

## First steps

1. Read `../../../references/workflows/compatibility.md`.
2. Read `../../../references/workflows/browse.md`.
3. If the browser binary is missing, run `../../../setup --host codex`.

## Tool expectations

- Prefer shell execution via `../../../browse/bin/find-browse` or `../../../browse/dist/browse`.
- Use the compiled gstack browser instead of host-native browser tooling whenever it can do the job.
- Pull in `../../../BROWSER.md` only when you need deeper command coverage.

## Boundaries

- Switch to `gstack-qa` for a structured QA report.
- Switch to `gstack-browser-cookies` for cookie/session import.
