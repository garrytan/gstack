# Codebase Audit Roadmap

Feature backlog for `/codebase-audit`, ordered by dependency and priority.

## PR 1: Core Skill (SHIPPED — PR #266)
Full audit pipeline: orientation → architecture scan → checklist scan → report.
Three modes: full, quick, regression. Health scoring, baseline.json, checklist.md,
report-template.md, git churn analysis, dependency CVE scanning.

## PR 2: Focused Mode + CI Mode (PLANNED — plans/PLAN-codebase-audit-pr2.md)
- [ ] **Focused mode** — `--security-only`, `--tests-only`, `--architecture-only`,
  `--performance-only`, `--debt-only`, `--correctness-only`, `--reliability-only`.
  Combinable flags. Score reflects only scanned categories.
- [ ] **CI mode** — `--ci --min-score N`. Separate execution path for pipelines.
  Non-interactive, machine-readable PASS/FAIL output, baseline.json only.
  Combinable with focused flags.

Detailed implementation plan: `plans/PLAN-codebase-audit-pr2.md`

## PR 3: E2E Test Coverage
- [ ] **Split-format E2E test** — `test/skill-e2e-audit.test.ts` in the new
  per-category test structure (upstream split `skill-e2e.test.ts` into 8 files).
- [ ] **Touchfile entry** — add codebase-audit dependencies to `test/helpers/touchfiles.ts`
  so diff-based selection picks it up.

## PR 3 Candidate: Per-Category Sub-Scores
- [ ] **Per-category scoring model** — each category gets its own 0-100 score
  (same deduction formula applied per-category). Aggregate = average of scanned
  category sub-scores. Adds `category_scores` to baseline.json and `scoring_version`
  field for regression compatibility. Deferred from PR 2 because it changes the
  scoring model in a way that breaks regression comparisons against PR 1 baselines.
  Needs a migration path (scoring_version field, skip delta when versions differ).

## Future: Custom Checklists
- [ ] **Project-local checklist items** — let users define additional checklist
  entries in CLAUDE.md or a `.gstack/audit-checklist.md` file. Merged with the
  built-in checklist at scan time. Enables domain-specific checks (e.g., "all
  API endpoints must have rate limiting" for a web service).

## Future: Diff-Aware Audit
- [ ] **Audit only changed files** — `--diff` or `--pr` flag that scopes the
  audit to files changed in the current branch/PR. Lighter than a full audit,
  deeper than `/review`. Useful for "did this PR introduce any of the checklist
  anti-patterns?" without scanning the whole codebase.

## Future: Auto-Fix Pipeline
- [ ] **Direct fix chaining** — beyond the current "write a plan and offer
  `/plan-eng-review`" flow, add a `--fix` flag that applies mechanical fixes
  (linter issues, dead code, TODO cleanup) automatically with atomic commits.
  Substantive fixes still go through the plan→review pipeline.

## Future: Cross-Audit Trending
- [ ] **Score trajectory** — compare multiple baseline.json files over time.
  Show health score trend (improving/declining), category-level breakdown,
  which findings were fixed vs. introduced between audits. Output as a
  markdown table or chart-ready data. Useful for "are we getting healthier?"
  reporting.
