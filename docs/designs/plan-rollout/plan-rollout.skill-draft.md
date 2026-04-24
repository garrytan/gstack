---
name: plan-rollout
preamble-tier: 4
version: 0.1.0
description: |
  Decompose a large change into a reviewable PR stack with a rollout plan.
  Reads SYSTEM.md (semantic contract graph) + the discovered package graph,
  produces decomposition.md and rollout.md — consumed downstream by /ship,
  /review, /spill-check, /land-and-deploy. Use when you have an approved plan
  (from /plan-eng-review or otherwise) and you're about to implement. Triggers:
  "plan the rollout", "decompose this", "break into PRs", "stack the PRs",
  "plan the shipping order". (gstack)
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
triggers:
  - plan the rollout
  - decompose this
  - break into prs
  - stack the prs
  - plan the shipping order
  - rollout plan
---

<!-- PREAMBLE: auto-generated from SKILL.md.tmpl by `bun run gen:skill-docs`.
     Includes: update check, telemetry opt-in, writing style, lake intro,
     voice, context recovery, AskUserQuestion format, completeness principle,
     confusion protocol, question tuning, repo ownership, search-before-building,
     completion status protocol, operational self-improvement, telemetry footer,
     plan-mode safe ops, skill-invocation-during-plan-mode, plan status footer. -->

## Step 0: Detect platform and base branch

Same as /ship and /plan-eng-review. Use the shared detection block.

## Overview

This skill sits between *plan approved* and *code written*. It answers: "how do I
decompose this work into a reviewable PR stack, and in what order should each unit
ship to production?"

The output is two artifacts (YAML frontmatter + markdown body):

- `~/.gstack/projects/$SLUG/decomposition.md` — the PR stack, one unit per PR,
  with files declared, reviewer reading-order, dependency edges, reviewer
  time-budget estimate, and an ASCII Gantt-style stack map.
- `~/.gstack/projects/$SLUG/rollout.md` — rollout strategy (flag / canary /
  migration-first / big-bang), step-by-step sequence with inverse rollback
  lines auto-generated, and the kill-switch runbook if flags are involved.

Downstream:
- `/spill-check` reads the decomposition to flag scope creep during
  implementation.
- `/ship` enters **stack mode** when `decomposition.md` exists, auto-creating
  the PR stack with reviewer guides.
- `/review` verifies the PR diff stays within its declared PR unit.
- `/land-and-deploy` sequences the rollout steps.

## Prerequisites

Before running, confirm:

1. A plan file exists in the conversation or on disk (from `/plan-eng-review`,
   `/plan-ceo-review`, or a user-authored plan).
2. The repo has `SYSTEM.md` at the root. If not, offer to scaffold (Step 2).
3. No active `decomposition.md` exists (if yes, prompt to revise or start fresh).

## Step 1: Discover inputs

Collect what you need to decompose:

```bash
# Current state
_BRANCH=$(git branch --show-current)
eval "$(~/.claude/skills/gstack/bin/gstack-slug)"
_ARTIFACTS_DIR="${GSTACK_HOME:-$HOME/.gstack}/projects/$SLUG"

# Source plan (from /plan-eng-review or /plan-ceo-review output)
_CEO_PLAN=$(ls -t "$_ARTIFACTS_DIR/ceo-plans"/*.md 2>/dev/null | head -1)
_ENG_PLAN=$(ls -t "$_ARTIFACTS_DIR/eng-plans"/*.md 2>/dev/null | head -1)

# SYSTEM.md presence
_SYSTEM_MD="$(git rev-parse --show-toplevel)/SYSTEM.md"
[ -f "$_SYSTEM_MD" ] && echo "SYSTEM_MD: present" || echo "SYSTEM_MD: missing"

# Existing decomposition (revision vs fresh)
_EXISTING_DECOMP="$_ARTIFACTS_DIR/decomposition.md"
[ -f "$_EXISTING_DECOMP" ] && echo "DECOMP: exists" || echo "DECOMP: fresh"

# Discovered change surface — either pending diff or plan-declared files
_DIFF_FILES=$(git diff --name-only "$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)" 2>/dev/null || true)
```

Read the plan file(s) to extract:
- Feature summary / user-facing outcome
- Declared scope (files, components, user flows)
- Accepted expansions from CEO review (if any)
- Deferred / out-of-scope items

## Step 2: SYSTEM.md scaffolder (only if missing)

If `SYSTEM.md` is missing, offer to scaffold. Never write it authoritatively
without user review.

Use AskUserQuestion:

> "No SYSTEM.md found at the repo root. /plan-rollout needs it to reason about
> role-level contracts between components. I can scan your repo and generate a
> draft based on top-level directories, package.json workspaces, CODEOWNERS
> (if present), and import-graph clustering. You review, edit, rename from
> `.draft` to `SYSTEM.md`, commit. Takes ~5 min of your time."
>
> RECOMMENDATION: Choose A — SYSTEM.md is the semantic spine this skill reasons
> over. Without it, decomposition falls back to file-level heuristics (worse).
> Completeness: A=9/10, B=5/10, C=3/10.

Options:
- A) Scaffold SYSTEM.md.draft now (recommended)
- B) Let me hand-write SYSTEM.md, then re-run /plan-rollout
- C) Run /plan-rollout without SYSTEM.md (degraded mode — flag-level only)

If A: run the scaffolder:

```bash
~/.claude/skills/gstack/lib/plan-rollout/system-map-scaffolder \
  --repo "$(git rev-parse --show-toplevel)" \
  --output "$(git rev-parse --show-toplevel)/SYSTEM.md.draft"
```

The scaffolder writes components with:
- `name`, `path`, `role` (inferred from directory name + README excerpt, TODO marker if unclear)
- `owns`: empty with TODO marker
- `contracts`: empty with TODO marker
- `rollout-order`: empty with TODO marker

Tell the user: *"Draft written to SYSTEM.md.draft. Review the TODO markers,
fill in role + contracts + rollout-order, rename to SYSTEM.md, commit, then
re-run /plan-rollout."*

**STOP.** Wait for user to complete the edit-and-rename cycle. Do not proceed
to Step 3 without a present-and-valid SYSTEM.md (unless user chose C).

If B: tell the user where the schema doc lives
(`~/.claude/skills/gstack/docs/SYSTEM-MD.md`) and stop.

If C: degraded mode — proceed to Step 3 with no component graph. `/spill-check`
can still run on file-level declarations. Note degradation in the output.

## Step 3: Reconcile declared contracts with discovered imports

Before decomposing, run reconciliation between SYSTEM.md (declared contracts)
and the package/import graph (discovered at runtime).

```bash
~/.claude/skills/gstack/lib/plan-rollout/system-map-reconcile \
  --system-md "$_SYSTEM_MD" \
  --repo "$(git rev-parse --show-toplevel)" \
  --format json > /tmp/reconcile-$$.json
```

The reconcile tool surfaces three categories of flag:

1. **Import without declared contract.** File X imports from file Y, but their
   components have no contract in SYSTEM.md.
2. **Contract without supporting imports.** Components X and Y have a contract
   declared but no code-level coupling was found (may be runtime-only: DB reads,
   message bus, HTTP, filesystem).
3. **Rollout-order inversion.** Declared rollout order contradicts the import
   direction.

For each flag, use AskUserQuestion:

> "Reconciliation flag: [category]. [Concrete example with file paths and
> component names]. Is this a declared contract gap, a layering violation, or
> noise?"
>
> RECOMMENDATION: [choose based on category heuristic]

Options:
- A) Add missing contract to SYSTEM.md now
- B) This is a layering violation — add to TODOS.md and proceed
- C) Noise / runtime-only coupling — suppress this flag and proceed
- D) Runtime-only coupling — add a contract with `note: runtime-only`

Batch up to 4 flags per question call for efficiency. If there are >12 flags,
present the top 8 sorted by severity (hard-edge contract gaps first).

**STOP** after the reconciliation pass completes. Wait for all user resolutions.

## Step 4: Decomposition ceremony

Now the core work. Given the plan + SYSTEM.md + discovered file set, propose a
PR decomposition.

### 4a. Propose units

For each proposed PR unit, output:

```
PR-UNIT #N:
  title:           <conventional-commits style>
  component:       <SYSTEM.md component name>
  files:           <list>
  depends-on:      <prior PR unit IDs>
  rationale:       <why this is a standalone unit>
  reading-order:   <files in the order a reviewer should open them>
  reviewer-mins:   <estimate>
```

### 4b. Unit-splitting heuristics (apply in priority order)

1. **Component boundary.** Files in different SYSTEM.md components go in
   different PR units unless a single indivisible user-facing outcome requires
   them together.
2. **Migration-first.** DB migrations always ship as PR #1 (or earliest),
   separate from code that reads the new schema.
3. **Interface-first.** Types, interfaces, and schemas go in an early PR; their
   implementers come after.
4. **Pure additions first, mutations later.** New code before edits to existing
   code when possible.
5. **Tests travel with their code.** Never a tests-only PR unless refactoring
   test infrastructure. Reviewers evaluate code + test jointly.
6. **Flag-gate before flag-flip.** Introduce a feature flag (off) as one PR;
   enable / roll out as a separate operational step, not a PR.
7. **Reviewer-budget cap.** No single PR unit exceeds 30 minutes of estimated
   review time. If it does, split further.

### 4c. Reviewer time-budget estimator

For each PR unit:

```
reviewer_mins = base + (loc / 20) + (files * 3) + test_bonus + complexity_bonus

base             = 2 minutes
loc / 20         = 1 minute per 20 lines changed
files * 3        = 3 minutes per file touched (context-switching cost)
test_bonus       = 5 minutes if PR contains tests (good — reviewers read them)
complexity_bonus = cyclomatic complexity delta × 2, capped at 10
```

v1 coefficients are a conservative default. Skill logs
`predicted_vs_actual_reviewer_time` to analytics so we can calibrate in v2
against real data.

### 4d. Present decomposition to user

AskUserQuestion (one question):

> "Proposed PR stack: [ASCII Gantt-style map]. Total: N PRs, estimated total
> reviewer time: M minutes. Does this decomposition make sense?"
>
> RECOMMENDATION: Confirm the decomposition. If any unit feels wrong, pick B
> and we'll iterate.

Options:
- A) Confirm — write decomposition.md and continue to rollout planning
- B) Revise — tell me what to split, merge, reorder, or re-scope
- C) Split further — every unit over 15 minutes becomes two
- D) Abort — this plan isn't ready for decomposition yet

If B: collect the user's guidance and re-propose. Loop until A or D.

## Step 5: Rollout ceremony

For each PR unit (or the stack as a whole), plan the rollout.

### 5a. Strategy selection

AskUserQuestion (one question per non-trivial PR unit, or one for the stack if
strategy is uniform):

> "Rollout strategy for [PR unit / whole stack]?"
>
> RECOMMENDATION: Depends on change surface. For code behind existing tested
> paths: big-bang. For user-visible features: flag. For data model changes:
> migration-first.

Options:
- A) Feature flag — ship behind a flag, enable in rollout step
- B) Canary — deploy to N% of traffic, watch, ramp
- C) Migration-first — DB migration as step 1, code after
- D) Big-bang — merge, deploy, done (only for low-risk changes)

### 5b. Inverse rollback auto-generation

For each rollout step, auto-generate its inverse:

| Forward action | Auto-generated rollback |
|----------------|--------------------------|
| Deploy binary vN | Re-deploy binary v(N-1) |
| Run migration M-up | Run migration M-down |
| Enable flag F | Disable flag F + clear cache |
| Ramp canary to 50% | Ramp canary to 0% |
| Update config key K to value V | Update config key K to previous value <prev> |

If a step's rollback is non-trivial (e.g., migration is non-reversible), flag
it loudly in the rollout.md as `rollback: MANUAL — see runbook <path>` and
require the user to specify the manual procedure.

### 5c. Verify step

For each rollout step, ask:

> "What metric / dashboard tells you this step succeeded?"

Store as `verify:` in the step. `/canary` will consume this post-deploy.

## Step 6: Write artifacts

```bash
~/.claude/skills/gstack/lib/plan-rollout/decomposition-writer \
  --output "$_ARTIFACTS_DIR/decomposition.md" \
  --units-json /tmp/units-$$.json

~/.claude/skills/gstack/lib/plan-rollout/rollout-writer \
  --output "$_ARTIFACTS_DIR/rollout.md" \
  --steps-json /tmp/rollout-$$.json
```

Both writers produce YAML frontmatter + human-readable markdown with the ASCII
Gantt diagram inline.

## Step 7: Review log + next-steps recommendation

Log to the review log for the Review Readiness Dashboard:

```bash
~/.claude/skills/gstack/bin/gstack-review-log "$(jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg commit "$(git rev-parse --short HEAD)" \
  --argjson units "$N_UNITS" \
  --argjson total_mins "$TOTAL_MINS" \
  '{skill:"plan-rollout", timestamp:$ts, status:"clean",
    pr_units:$units, total_reviewer_mins:$total_mins, commit:$commit}')"
```

Recommend next steps via AskUserQuestion:

Options:
- A) Start implementing PR #1 now — I'll also enable /spill-check monitoring
- B) Review the decomposition.md and rollout.md first, then start
- C) Run /plan-design-review on the stack (if any unit has UI scope)

## Completion Summary

```
+================================================================+
|            /plan-rollout — COMPLETION SUMMARY                   |
+================================================================+
| SYSTEM.md           | present / scaffolded / skipped (degraded)|
| Reconciliation      | N flags, N resolved, N suppressed         |
| PR units            | N                                         |
| Total reviewer mins | M                                         |
| Rollout strategy    | flag / canary / migration-first / big-bang|
| Rollout steps       | N with auto-rollback, K manual            |
| Artifacts           | decomposition.md, rollout.md              |
| Next                | start PR #1 / review artifacts / design   |
+================================================================+
```

## Plan File Review Report

Same pattern as /plan-ceo-review: update `## GSTACK REVIEW REPORT` in the plan
file if present.

## Capture Learnings

Log non-obvious decomposition patterns observed during the session, especially
when user guidance overrode a default heuristic. These compound over sessions.

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"plan-rollout",...}'
```

<!-- TELEMETRY FOOTER: auto-generated from SKILL.md.tmpl -->
