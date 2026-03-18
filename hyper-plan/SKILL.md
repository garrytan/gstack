---
name: hyper-plan
version: 1.0.0
description: |
  Recursive codebase improvement with convergence scoring. Chains /plan-ceo-review →
  /plan-eng-review → execute fixes → /qa into an iterative loop with LLM-as-Judge
  convergence control. Use when asked to "improve this codebase", "upgrade quality",
  "iterate until good", "recursive review", "keep improving until done", "hyper plan",
  or "convergence review". Treats quality like gradient descent — each iteration targets
  the 2 weakest dimensions until the overall grade hits the target (default 8.0/10).
allowed-tools:
  - Write
  - Edit
  - Read
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

If `LAKE_INTRO` is `no`: Before continuing, introduce the Completeness Principle.
Tell the user: "gstack follows the **Boil the Lake** principle — always do the complete
thing when AI makes the marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Then offer to open the essay in their default browser:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

Only run `open` if the user says yes. Always run `touch` to mark as seen. This only happens once.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` — always prefer the complete option over shortcuts (see Completeness Principle). Include `Completeness: X/10` for each option. Calibration: 10 = complete implementation (all edge cases, full coverage), 7 = covers happy path but skips some edges, 3 = shortcut that defers significant work. If both options are 8+, pick the higher; if one is ≤5, flag it.
4. **Options:** Lettered options: `A) ... B) ... C) ...` — when an option involves effort, show both scales: `(human: ~X / CC: ~Y)`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Completeness Principle — Boil the Lake

AI-assisted coding makes the marginal cost of completeness near-zero. When you present options:

- If Option A is the complete implementation (full parity, all edge cases, 100% coverage) and Option B is a shortcut that saves modest effort — **always recommend A**. The delta between 80 lines and 150 lines is meaningless with CC+gstack. "Good enough" is the wrong instinct when "complete" costs minutes more.
- **Lake vs. ocean:** A "lake" is boilable — 100% test coverage for a module, full feature implementation, handling all edge cases, complete error paths. An "ocean" is not — rewriting an entire system from scratch, adding features to dependencies you don't control, multi-quarter platform migrations. Recommend boiling lakes. Flag oceans as out of scope.
- **When estimating effort**, always show both scales: human team time and CC+gstack time. The compression ratio varies by task type — use this reference:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

- This principle applies to test coverage, error handling, documentation, edge cases, and feature completeness. Don't skip the last 10% to "save time" — with AI, that 10% costs seconds.

**Anti-patterns — DON'T do this:**
- BAD: "Choose B — it covers 90% of the value with less code." (If A is only 70 lines more, choose A.)
- BAD: "We can skip edge case handling to save time." (Edge case handling costs minutes with CC.)
- BAD: "Let's defer test coverage to a follow-up PR." (Tests are the cheapest lake to boil.)
- BAD: Quoting only human-team effort: "This would take 2 weeks." (Say: "2 weeks human / ~1 hour CC.")

## Contributor Mode

If `_CONTRIB` is `true`: you are in **contributor mode**. You're a gstack user who also helps make it better.

**At the end of each major workflow step** (not after every single command), reflect on the gstack tooling you used. Rate your experience 0 to 10. If it wasn't a 10, think about why. If there is an obvious, actionable bug OR an insightful, interesting thing that could have been done better by gstack code or skill markdown — file a field report. Maybe our contributor will help make us better!

**Calibration — this is the bar:** For example, `$B js "await fetch(...)"` used to fail with `SyntaxError: await is only valid in async functions` because gstack didn't wrap expressions in async context. Small, but the input was reasonable and gstack should have handled it — that's the kind of thing worth filing. Things less consequential than this, ignore.

**NOT worth filing:** user's app bugs, network errors to user's URL, auth failures on user's site, user's own JS logic bugs.

**To file:** write `~/.gstack/contributor-logs/{slug}.md` with **all sections below** (do not truncate — include every section through the Date/Version footer):

```
# {Title}

Hey gstack team — ran into this while using /{skill-name}:

**What I was trying to do:** {what the user/agent was attempting}
**What happened instead:** {what actually happened}
**My rating:** {0-10} — {one sentence on why it wasn't a 10}

## Steps to reproduce
1. {step}

## Raw output
```
{paste the actual error or unexpected output here}
```

## What would make this a 10
{one sentence: what gstack should have done differently}

**Date:** {YYYY-MM-DD} | **Version:** {gstack version} | **Skill:** /{skill}
```

Slug: lowercase, hyphens, max 60 chars (e.g. `browse-js-no-await`). Skip if file already exists. Max 3 reports per session. File inline and continue — don't stop the workflow. Tell user: "Filed gstack field report: {title}"

## Step 0: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

1. Check if a PR already exists for this branch:
   `gh pr view --json baseRefName -q .baseRefName`
   If this succeeds, use the printed branch name as the base branch.

2. If no PR exists (command fails), detect the repo's default branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

3. If both commands fail, fall back to `main`.

Print the detected base branch name. In every subsequent `git diff`, `git log`,
`git fetch`, `git merge`, and `gh pr create` command, substitute the detected
branch name wherever the instructions say "the base branch."

---

# /hyper-plan: Recursive Codebase Improvement

You are running the `/hyper-plan` workflow. This orchestrates existing gstack skills in an iterative loop — each round reviews, fixes, validates, and scores the codebase until it converges on a quality target.

## Why This Exists

Individual `/plan-ceo-review` and `/plan-eng-review` passes find issues but don't close the loop. After a review, you manually decide what to fix, fix it, and hope you didn't break something else. There's no convergence criteria, no regression detection, and findings aren't tracked across iterations.

`/hyper-plan` treats codebase quality like gradient descent — each iteration moves toward a target grade, focused tighter each round on the weakest dimensions.

---

## Parameters

Parse the user's request for these parameters:

| Parameter | Default | Override example |
|-----------|---------|------------------|
| Target grade | 8.0 | `--target 9.0` |
| Max iterations | 7 | `--max 5` |
| Focus | All dimensions | `--focus security,tests` |
| Fix scope | P0 + P1 only | `--fix-all` (include P2) |

---

## Step 0: Baseline

Before the first iteration, establish where the codebase stands today.

1. Check existing review state:

## Review Readiness Dashboard

After completing the review, read the review log and config to display the dashboard.

```bash
eval $(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)
cat ~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl 2>/dev/null || echo "NO_REVIEWS"
echo "---CONFIG---"
~/.claude/skills/gstack/bin/gstack-config get skip_eng_review 2>/dev/null || echo "false"
```

Parse the output. Find the most recent entry for each skill (plan-ceo-review, plan-eng-review, plan-design-review, design-review-lite). Ignore entries with timestamps older than 7 days. For Design Review, show whichever is more recent between `plan-design-review` (full visual audit) and `design-review-lite` (code-level check). Append "(FULL)" or "(LITE)" to the status to distinguish. Display:

```
+====================================================================+
|                    REVIEW READINESS DASHBOARD                       |
+====================================================================+
| Review          | Runs | Last Run            | Status    | Required |
|-----------------|------|---------------------|-----------|----------|
| Eng Review      |  1   | 2026-03-16 15:00    | CLEAR     | YES      |
| CEO Review      |  0   | —                   | —         | no       |
| Design Review   |  0   | —                   | —         | no       |
+--------------------------------------------------------------------+
| VERDICT: CLEARED — Eng Review passed                                |
+====================================================================+
```

**Review tiers:**
- **Eng Review (required by default):** The only review that gates shipping. Covers architecture, code quality, tests, performance. Can be disabled globally with \`gstack-config set skip_eng_review true\` (the "don't bother me" setting).
- **CEO Review (optional):** Use your judgment. Recommend it for big product/business changes, new user-facing features, or scope decisions. Skip for bug fixes, refactors, infra, and cleanup.
- **Design Review (optional):** Use your judgment. Recommend it for UI/UX changes. Skip for backend-only, infra, or prompt-only changes.

**Verdict logic:**
- **CLEARED**: Eng Review has >= 1 entry within 7 days with status "clean" (or \`skip_eng_review\` is \`true\`)
- **NOT CLEARED**: Eng Review missing, stale (>7 days), or has open issues
- CEO and Design reviews are shown for context but never block shipping
- If \`skip_eng_review\` config is \`true\`, Eng Review shows "SKIPPED (global)" and verdict is CLEARED

2. Read CLAUDE.md, TODOS.md, and any architecture docs for project context.

3. Run a quick system audit:

```bash
git log --oneline -20
git diff --stat
```

4. Score the codebase across 10 quality dimensions (1-10 each). Read source files, tests, configs — do not guess. Every score needs file:line evidence.

```
DIMENSION RUBRIC — every score requires file:line evidence
───────────────────────────────────────────────────────────────────────────
Code Quality
  1-3: God classes, copy-paste duplication, no naming conventions
  4-6: Mostly clean, some long functions (>50 LOC), inconsistent style
  7-8: Consistent patterns (DI, SRP), linter configured and passing
  9-10: Exemplary — refactoring would not improve readability

Security
  1-3: SQL injection, hardcoded secrets, missing auth on endpoints
  4-6: Parameterized queries, env vars for secrets, basic auth
  7-8: Defense in depth — CSRF, rate limiting, input validation everywhere
  9-10: Threat-modeled, SAST in CI, security headers configured

Performance
  1-3: N+1 queries, no indexes, blocking I/O in hot paths
  4-6: Indexed queries, no obvious N+1s, reasonable response times
  7-8: Cached hot paths, profiled, pagination on all list endpoints
  9-10: p99 <200ms measured, lazy loading, connection pooling, CDN

UX/UI
  1-3: Broken flows, no loading states, layout shifts
  4-6: Functional — all paths work, basic error messages
  7-8: Loading/error/empty states everywhere, responsive, consistent
  9-10: Delightful — transitions, optimistic updates, keyboard navigation

Tests
  1-3: <30% coverage or no test files at all
  4-6: Happy paths tested, >50% coverage, no integration tests
  7-8: Edge cases and error paths, >80% coverage, CI-enforced
  9-10: Mutation-tested, contract tests, E2E for critical flows

Accessibility
  1-3: No aria attributes, no alt text, failing contrast
  4-6: Basic labels, some alt text, mostly passing contrast
  7-8: WCAG AA compliant, keyboard navigable, screen reader tested
  9-10: WCAG AAA, skip links, focus management, reduced motion

Documentation
  1-3: No README or stale README with wrong instructions
  4-6: README with setup instructions, some inline comments
  7-8: API docs (OpenAPI/JSDoc), architecture decision records
  9-10: Onboarding guide, runbooks, troubleshooting FAQ

Error Handling
  1-3: Silent catches, swallowed exceptions, `catch {}` blocks
  4-6: Errors logged, user-facing error messages
  7-8: Typed errors, retry with backoff, graceful degradation
  9-10: Circuit breakers, dead letter queues, error budgets tracked

Observability
  1-3: console.log only, no structured output
  4-6: Logging framework, basic request logging
  7-8: Structured logs (JSON), metrics (latency, error rate), request IDs
  9-10: Distributed tracing, alerting, dashboards, SLO tracking

Deploy Safety
  1-3: Manual deploy, no CI, no rollback plan
  4-6: CI pipeline exists, automated tests run before merge
  7-8: Staged deploys, automated rollback, DB migration strategy
  9-10: Canary/blue-green, feature flags, deploy-time health checks
```

5. Compute overall grade: average of all 10 dimensions.

6. Present baseline to the user:

Use AskUserQuestion to confirm target grade and show the baseline scores. If the baseline already meets the target, congratulate and stop.

```
Baseline: X.X/10 — Target: Y.Y/10

| Dimension       | Score | Key Evidence |
|-----------------|-------|--------------|
| Code Quality    | ?     | file:line    |
| Security        | ?     | file:line    |
| ...             |       |              |

RECOMMENDATION: Choose A to begin iterating.
A) Start iteration 1 (target: Y.Y)
B) Adjust target grade
C) Focus on specific dimensions only
```

Save baseline to `.hyper-plan/baseline.md`.

---

## Step 1: Review (each iteration)

**Iteration 1:** Run full review — invoke `/plan-ceo-review` (HOLD SCOPE mode) followed by `/plan-eng-review`. Compile all findings into a prioritized list:

- **P0 — Critical:** Security vulnerabilities, data loss risks, crashes
- **P1 — High:** Silent failures, missing validation, broken flows
- **P2 — Medium:** Code smells, missing tests, documentation gaps
- **P3 — Low:** Style issues, naming, minor refactors

**Iterations 2+:** Focus ONLY on the 2 lowest-scoring dimensions from the previous round. This focus narrowing is how convergence happens — reviewing everything every round causes thrashing.

How focus narrowing works:
1. After re-scoring in Step 4, sort all 10 dimensions by score ascending.
2. The bottom 2 become the focus for the next iteration.
3. Only review source files relevant to those 2 dimensions — skip the rest.
4. If a focused dimension reaches 8.0+, it graduates from focus and the next-lowest dimension takes its slot.
5. A dimension that graduated can re-enter focus if it later drops below its graduation score (see oscillation detection in Step 5).

Read source files in those dimensions, identify remaining gaps, and compile findings.

Write findings to `.hyper-plan/iteration-N-findings.md`.

---

## Step 2: Fix

Execute P0 and P1 fixes (or P0-P2 if `--fix-all` was specified).

For each fix:
1. Read the source code and understand context before changing anything
2. Make the minimal fix — smallest change that resolves the issue
3. Do NOT refactor surrounding code or add features

After each batch of fixes, run the validation gate:

```bash
# Detect and run project linter/type-checker/tests
# Python projects:
ruff check . 2>/dev/null || true
mypy . 2>/dev/null || true
pytest 2>/dev/null || true

# Node/TypeScript projects:
npx tsc --noEmit 2>/dev/null || true
npm run lint 2>/dev/null || true
npm test 2>/dev/null || true
```

If the validation gate fails:
1. Try to fix the failure (lint error, type error, test failure)
2. If the fix introduces more failures than it resolves, revert it: `git checkout -- <files>`
3. Mark the finding as "deferred — fix caused regression"

Commit each successful fix batch:

```bash
git add <fixed-files>
git commit -m "fix(hyper-plan): iteration N — <summary of fixes>"
```

---

## Step 3: Verify

After fixes are committed, run `/qa` in diff-aware mode to verify nothing regressed. If `/qa` finds new issues introduced by the fixes, treat them as P0 findings for the next iteration.

---

## Step 4: Re-score

Score all 10 dimensions again. The judge (you) must read actual source code with file:line evidence — do not trust fix-agent self-reports or assume a committed fix actually resolved the issue.

Compute the new overall grade and delta from the previous iteration.

Write scores to `.hyper-plan/iteration-N-scores.md`.

---

## Step 5: Convergence Check

Check these conditions in priority order:

1. **DEGRADED:** Any dimension score decreased by **more than 0.5** from the previous iteration. Something went wrong — HALT immediately. Show the user which dimension degraded, what changed, and recommend reverting the iteration's commits.

   Small decreases (≤0.5) are normal variance — re-scoring the same code can fluctuate slightly depending on which files the judge reads first. Do NOT halt on minor variance. Instead, note it as "soft regression" in the iteration scores file and monitor it next round.

2. **OSCILLATING:** A dimension has changed direction 3+ times across iterations (e.g., up→down→up or 6.0→6.5→6.2→6.4). This indicates thrashing — fixes in one area are destabilizing another. Lock the oscillating dimension at its current score, remove it from focus, and add a note to the convergence summary explaining why it was locked. Redirect focus to dimensions that are still monotonically improving.

3. **SUCCESS:** Overall grade >= target grade. Congratulations — the codebase has reached the target quality level. Output the convergence summary and stop.

4. **CONVERGED:** Improvement delta < 0.2 for 2 consecutive iterations. The codebase has plateaued — further iterations won't meaningfully improve quality at this difficulty level. Output the convergence summary with a note about diminishing returns.

5. **MAX_REACHED:** Iteration count >= max iterations. Stop gracefully. Output the convergence summary with remaining improvement opportunities.

6. **CONTINUE:** None of the above triggered. Identify the 2 lowest-scoring dimensions, note them as the focus for the next iteration, and return to Step 1.

---

## Output Structure

```
.hyper-plan/
├── baseline.md                    # Initial scores + evidence
├── iteration-1-findings.md        # Review findings
├── iteration-1-scores.md          # Post-fix scores
├── iteration-2-findings.md
├── iteration-2-scores.md
├── ...
└── convergence-summary.md         # Final report
```

---

## Convergence Summary

At the end (regardless of exit condition), produce:

```
┌────────────────────────────────────────────────────────────┐
│           HYPER-PLAN CONVERGENCE SUMMARY                   │
├────────────────────────────────────────────────────────────┤
│ Exit condition  │ SUCCESS / CONVERGED / DEGRADED / MAX     │
│ Iterations      │ N                                        │
│ Baseline grade  │ X.X/10                                   │
│ Final grade     │ Y.Y/10                                   │
│ Total delta     │ +Z.Z                                     │
│ Target          │ T.T/10                                   │
│ Commits         │ N commits, M files changed               │
├────────────────────────────────────────────────────────────┤
│ Dimension       │ Baseline │ Final │ Delta                  │
│ Code Quality    │    X     │   Y   │  +Z                    │
│ Security        │    X     │   Y   │  +Z                    │
│ Performance     │    X     │   Y   │  +Z                    │
│ UX/UI           │    X     │   Y   │  +Z                    │
│ Tests           │    X     │   Y   │  +Z                    │
│ Accessibility   │    X     │   Y   │  +Z                    │
│ Documentation   │    X     │   Y   │  +Z                    │
│ Error Handling  │    X     │   Y   │  +Z                    │
│ Observability   │    X     │   Y   │  +Z                    │
│ Deploy Safety   │    X     │   Y   │  +Z                    │
├────────────────────────────────────────────────────────────┤
│ Deferred items  │ N (listed below)                         │
└────────────────────────────────────────────────────────────┘
```

Write to `.hyper-plan/convergence-summary.md`.

If the repo has a `TODOS.md`, add any deferred findings as TODOs with severity and context.

---

## Example Convergence

```
| Iteration | Grade | Delta | Focus             | Verdict  |
|-----------|-------|-------|-------------------|----------|
| Baseline  | 5.4   | —     | All               | —        |
| 1         | 6.2   | +0.8  | All               | CONTINUE |
| 2         | 6.8   | +0.6  | Tests, Security   | CONTINUE |
| 3         | 7.2   | +0.4  | Perf, Deploy      | CONTINUE |
| 4         | 7.5   | +0.3  | UX, Docs          | CONTINUE |
| 5         | 7.8   | +0.3  | Errors, Observ.   | CONTINUE |
| 6         | 8.1   | +0.3  | —                 | SUCCESS  |
```

---

## Integration

This skill orchestrates — it does not replace — existing gstack skills:

- `/plan-ceo-review` (HOLD SCOPE mode) for strategic review in iteration 1
- `/plan-eng-review` for architecture + robustness review in iteration 1
- `/qa` (diff-aware mode) for post-fix verification each iteration

When invoking these skills, read their SKILL.md files and follow their full protocols. Do not abbreviate or skip steps within those skills.

---

## Important Rules

1. **Judge reads source code.** Every score needs file:line evidence. Do not trust summaries or self-reports.
2. **Validation gate before every commit.** Lint + types + tests must pass.
3. **One commit per fix batch.** Each iteration's fixes get one atomic commit.
4. **Revert on regression.** If a fix makes things worse, `git checkout -- <files>` immediately.
5. **Focus narrows each iteration.** After iteration 1, review only the 2 weakest dimensions.
6. **All artifacts saved.** Every iteration's findings and scores go to `.hyper-plan/` for auditability.
7. **Never skip /qa verification.** Even if you're confident the fixes are correct, verify.
8. **Deferred items become TODOs.** Anything not fixed goes to TODOS.md with context.
9. **Track direction per dimension.** Record whether each dimension went up, down, or flat each iteration. If a dimension changes direction 3+ times, it is oscillating — lock it and move on.
10. **Small variance is not degradation.** A ≤0.5 decrease is normal re-scoring noise. Only HALT on >0.5 drops.
