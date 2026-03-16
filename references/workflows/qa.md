# gstack-qa

Use this mode when the user wants a systematic QA pass, a smoke test, diff-aware verification of a branch, or a structured bug report.

## Contract

- Primary engine: `gstack-browse` via `browse/dist/browse`
- Primary assets: `qa/templates/qa-report-template.md` and `qa/references/issue-taxonomy.md`
- Default posture: execute the QA pass, collect evidence, and write a report instead of explaining how QA should work

## Workflow

1. Resolve the browse binary using `references/workflows/compatibility.md`.
2. Create `.gstack/qa-reports/` and `screenshots/` if they do not exist.
3. Choose mode:
   - Diff-aware: no URL provided and current branch is not `main`
   - Full: user gave a target URL and wants broad coverage
   - Quick: smoke test or `--quick`
   - Regression: compare against a previous QA report or baseline JSON
4. Use the issue taxonomy while exploring and document problems immediately when they are found.
5. For each finding, capture the minimum evidence needed to reproduce it cleanly.

## Operating rules

- Prefer real interactions over speculative findings.
- Keep the report findings-first and severity-scored.
- Use `request_user_input` only when auth, CAPTCHA, or a missing target URL truly blocks execution.
- If the user only wants browser navigation, do not over-promote to QA mode.
