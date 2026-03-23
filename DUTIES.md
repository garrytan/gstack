# Duties

## The Sprint Workflow
gstack follows a structured sprint process. Each skill feeds into the next:

**Think → Plan → Build → Review → Test → Ship → Reflect**

### Think
- `/office-hours` — Reframe the problem before writing code. Six forcing questions that expose demand reality, status quo, and the narrowest wedge.

### Plan
- `/plan-ceo-review` — Rethink the problem. Find the 10-star product. Four modes: Expansion, Selective Expansion, Hold Scope, Reduction.
- `/plan-eng-review` — Lock architecture, data flow, diagrams, edge cases, and tests. Force hidden assumptions into the open.
- `/plan-design-review` — Rate each design dimension 0-10, explain what a 10 looks like, edit the plan to get there.
- `/design-consultation` — Build a complete design system from scratch. Research the landscape, propose creative risks, generate mockups.

### Build
- `/investigate` — Systematic root-cause debugging. Iron Law: no fixes without investigation.
- `/careful` — Safety guardrails for destructive commands.
- `/freeze` / `/unfreeze` — Scope-lock file edits to one directory.
- `/guard` — Maximum safety: careful + freeze combined.

### Review
- `/review` — Pre-landing PR review. SQL safety, LLM trust boundaries, conditional side effects, structural issues. Auto-fixes obvious problems.
- `/design-review` — Visual design audit with code fixes. Atomic commits, before/after screenshots.
- `/codex` — Independent second opinion from OpenAI Codex CLI. Cross-model analysis.

### Test
- `/qa` — Test the app, find bugs, fix them with atomic commits, re-verify. Auto-generates regression tests.
- `/qa-only` — Report-only QA without code changes.
- `/benchmark` — Baseline page load times, Core Web Vitals, resource sizes. Before/after comparison.
- `/browse` — Headless browser for QA testing and dogfooding.

### Ship
- `/ship` — Sync main, run tests, audit coverage, push, open PR. Bootstraps test frameworks if needed.
- `/land-and-deploy` — Merge PR, wait for CI/deploy, verify production health.
- `/canary` — Post-deploy monitoring loop. Console errors, performance regressions, page failures.
- `/document-release` — Update all project docs to match what was shipped.

### Reflect
- `/retro` — Team-aware weekly retro. Per-person breakdowns, shipping streaks, test health trends.

## Parallel Sprint Management
Run 10-15 sprints in parallel. Different features, different branches, different agents — all at the same time. The sprint structure is what makes parallelism work: each agent knows exactly what to do and when to stop.
