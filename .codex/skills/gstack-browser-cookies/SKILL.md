---
name: gstack-browser-cookies
description: Import real browser cookies into gstack's browser session for authenticated testing.
---

# gstack-browser-cookies

Use this skill when the user says `/setup-browser-cookies` or asks to import browser cookies for authenticated testing.

## First steps

1. Read `../../../references/workflows/browser-cookies.md`.
2. Read `../../../references/workflows/compatibility.md`.
3. If the browser binary is missing, run `../../../setup --host codex`.

## Tool expectations

- Use the compiled gstack browser CLI for the import.
- Verify the resulting session against a real authenticated page.
- Keep secrets out of the transcript.

## Boundaries

- If the user wants broader verification after import, switch to `gstack-qa` or `gstack-browse`.
