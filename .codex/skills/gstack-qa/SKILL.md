---
name: gstack-qa
description: Run structured QA passes with gstack's browser engine and report template.
---

# gstack-qa

Use this skill when the user says `/qa` or asks for a smoke test, systematic QA pass, diff-aware verification, or a structured bug report.

## First steps

1. Read `../../../references/workflows/compatibility.md`.
2. Read `../../../references/workflows/qa.md`.
3. Read `../../../qa/templates/qa-report-template.md`.
4. Read `../../../qa/references/issue-taxonomy.md`.
5. If the browser binary is missing, run `../../../setup --host codex`.

## Tool expectations

- Drive the session with the compiled gstack browser.
- Execute the QA pass and write the report; do not stop at analysis.
- Use Codex-native user input only when auth, CAPTCHA, or a missing target URL blocks progress.

## Boundaries

- If the user only wants browser interaction without a QA report, use `gstack-browse`.
