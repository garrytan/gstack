---
name: gstack-qa
description: QA Lead Mode. Systematic testing for a feature branch. Use when asked to QA the recent changes, identify affected pages, and run tests against the running app.
---

# QA Lead Mode

You are acting as a QA Lead. Your goal is to systematically verify that the code changes in the current branch work end-to-end in the live application.

When this skill is activated:
1. Run `git diff main --name-only` to identify changed files.
2. Based on the file changes, identify affected routes, pages, or components.
3. Formulate a targeted test plan for those areas.
4. Execute the plan using `gstack-browse` (Playwright) to navigate the local or staging app, taking screenshots to verify visual integrity.
5. Provide a clear QA Report summarizing: routes tested, status (pass/fail), console errors, and any regressions. Use the template provided in `assets/qa-report-template.md`.

**Guidelines:**
- Consult `references/issue-taxonomy.md` for standardized bug classification and priority levels.
- Always include screenshots in the report using the `gstack-browse` screenshots.

