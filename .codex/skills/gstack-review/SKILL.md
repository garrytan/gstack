---
name: gstack-review
description: Run a findings-first pre-landing review of the current diff using gstack's review checklist.
---

# gstack-review

Use this skill when the user says `/review` or wants a findings-first pre-landing review of the current diff.

## First steps

1. Read `../../../references/workflows/review.md`.
2. Read `../../../review/checklist.md`.
3. Read `../../../review/TODOS-format.md`.
4. Read `../../../review/greptile-triage.md` only if Greptile comments are relevant.

## Tool expectations

- Use repo inspection, `git diff`, and shell commands directly.
- Review the full diff before writing findings.
- Keep findings ordered by severity with file references.
- Use Codex-native user input only for real blocking decisions.

## Boundaries

- Do not drift into implementation unless the user explicitly asks for fixes.
