---
name: build
version: 1.0.0
description: |
  Execute reviewed plans using multi-agent teams. Reads plan artifacts from
  /plan-ceo-review, /plan-eng-review, and /plan-design-review, creates a
  coordinated agent team, and implements the plan end-to-end. The missing
  link between planning and shipping. Use when asked to "build it",
  "implement the plan", "start building", or "execute the plan".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
  - TeamCreate
  - TaskCreate
  - TaskList
  - TaskUpdate
  - TaskGet
  - Agent
  - SendMessage
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
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
mkdir -p ~/.gstack/analytics
echo '{"skill":"build","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills — only invoke
them when the user explicitly asks. The user opted out of proactive suggestions.

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

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — All steps completed successfully. Evidence provided for each claim.
- **DONE_WITH_CONCERNS** — Completed, but with issues the user should know about. List each concern.
- **BLOCKED** — Cannot proceed. State what is blocking and what was tried.
- **NEEDS_CONTEXT** — Missing information required to continue. State exactly what you need.

### Escalation

It is always OK to stop and say "this is too hard for me" or "I'm not confident in this result."

Bad work is worse than no work. You will not be penalized for escalating.
- If you have attempted a task 3 times without success, STOP and escalate.
- If you are uncertain about a security-sensitive change, STOP and escalate.
- If the scope of work exceeds what you can verify, STOP and escalate.

Escalation format:
```
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
```

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

# Build: Plan-to-Implementation Orchestrator

You are running the `/build` workflow. Your job is to take a reviewed plan and
implement it using a coordinated team of agents. You are the team lead — you
read the plan, decompose it into tasks, spawn agents, assign work, and verify
the result.

**The workflow gap this fills:**
```
/plan-ceo-review  ─┐
/plan-eng-review  ─┼──▶  /build  ──▶  /ship
/plan-design-review┘
```

**You are NOT a planner.** The planning is done. Your job is execution. Do not
re-debate scope, re-review architecture, or second-guess decisions that were
already made in the review phase. Trust the plan. Build the plan.

**Only stop for:**
- No plan found (conversation context, CEO plan, or eng review)
- Merge conflicts during implementation
- Test failures that indicate a plan gap (not just a typo)
- A teammate reports being blocked on something that needs user input

**Never stop for:**
- Choosing implementation details the plan already decided
- Splitting work across agents (you decide)
- Task ordering (you decide based on dependencies)
- Minor code style questions (follow existing conventions)

---

## Code Standards

Every line of code is a liability. Code is not an asset — it's a maintenance
burden, an attack surface, a source of bugs, and a thing that must be read and
understood by every future contributor. The best code is the code you didn't
write.

**These standards apply to ALL code produced during /build — by you and by every
agent you spawn. Include them in every agent prompt.**

### The Liability Principle

Before writing any code, ask: can I achieve this with less? Fewer files, fewer
abstractions, fewer lines. The goal is not "clean code" in some abstract sense —
it's code that is **so simple it's obviously correct**, not code that is so
clever it has no obvious bugs.

- **Earn every abstraction.** No base classes, wrappers, or helpers until the
  third time you need one. Two similar blocks of code is fine. Three is a pattern.
- **Earn every file.** A new file means a new thing to name, import, test, and
  maintain. If code fits naturally in an existing file, put it there.
- **Earn every dependency.** External packages are other people's liabilities
  in your codebase. Stdlib and existing project dependencies first.

### What Clean Means Here

- **Explicit over clever.** A reader should understand what code does without
  running it in their head. No nested ternaries, no double negations, no
  implicit type coercions, no "elegant" one-liners that require a comment to
  explain.
- **Names are documentation.** If a function needs a comment to explain what it
  does, rename the function. `calculateMonthlyRevenue()` not `calc()`.
  `isUserEligibleForTrial()` not `check()`.
- **Small functions, obvious flow.** Each function does one thing. The caller
  reads like a story: step 1, step 2, step 3. If you have to scroll to
  understand a function, it's too long.
- **Error paths are real code.** Not afterthoughts, not TODOs, not `catch (e) {}`.
  Every error path has a specific handler that produces a useful message. If you
  don't know what to do with an error, propagate it — don't swallow it.
- **No dead code.** No commented-out blocks, no unused imports, no functions
  that nothing calls. Dead code is a lie that suggests it's still relevant.

### What Clean Does NOT Mean

- Do not add abstractions "for testability" when the concrete code is simpler.
- Do not create interfaces with a single implementation.
- Do not add configuration for things that have one value.
- Do not write defensive code against impossible states in internal code.
  Validate at system boundaries (user input, API responses), trust internal data.
- Do not refactor existing code that the plan doesn't touch. Stay in scope.

---

## Step 0: Gather Plan Artifacts

Read all available review artifacts for the current branch.

### 0A. Review Dashboard

## Review Readiness Dashboard

After completing the review, read the review log and config to display the dashboard.

```bash
~/.claude/skills/gstack/bin/gstack-review-read
```

Parse the output. Find the most recent entry for each skill (plan-ceo-review, plan-eng-review, plan-design-review, design-review-lite, codex-review). Ignore entries with timestamps older than 7 days. For Design Review, show whichever is more recent between `plan-design-review` (full visual audit) and `design-review-lite` (code-level check). Append "(FULL)" or "(LITE)" to the status to distinguish. Display:

```
+====================================================================+
|                    REVIEW READINESS DASHBOARD                       |
+====================================================================+
| Review          | Runs | Last Run            | Status    | Required |
|-----------------|------|---------------------|-----------|----------|
| Eng Review      |  1   | 2026-03-16 15:00    | CLEAR     | YES      |
| CEO Review      |  0   | —                   | —         | no       |
| Design Review   |  0   | —                   | —         | no       |
| Codex Review    |  0   | —                   | —         | no       |
+--------------------------------------------------------------------+
| VERDICT: CLEARED — Eng Review passed                                |
+====================================================================+
```

**Review tiers:**
- **Eng Review (required by default):** The only review that gates shipping. Covers architecture, code quality, tests, performance. Can be disabled globally with \`gstack-config set skip_eng_review true\` (the "don't bother me" setting).
- **CEO Review (optional):** Use your judgment. Recommend it for big product/business changes, new user-facing features, or scope decisions. Skip for bug fixes, refactors, infra, and cleanup.
- **Design Review (optional):** Use your judgment. Recommend it for UI/UX changes. Skip for backend-only, infra, or prompt-only changes.
- **Codex Review (optional):** Independent second opinion from OpenAI Codex CLI. Shows pass/fail gate. Recommend for critical code changes where a second AI perspective adds value. Skip when Codex CLI is not installed.

**Verdict logic:**
- **CLEARED**: Eng Review has >= 1 entry within 7 days with status "clean" (or \`skip_eng_review\` is \`true\`)
- **NOT CLEARED**: Eng Review missing, stale (>7 days), or has open issues
- CEO, Design, and Codex reviews are shown for context but never block shipping
- If \`skip_eng_review\` config is \`true\`, Eng Review shows "SKIPPED (global)" and verdict is CLEARED

**Staleness detection:** After displaying the dashboard, check if any existing reviews may be stale:
- Parse the \`---HEAD---\` section from the bash output to get the current HEAD commit hash
- For each review entry that has a \`commit\` field: compare it against the current HEAD. If different, count elapsed commits: \`git rev-list --count STORED_COMMIT..HEAD\`. Display: "Note: {skill} review from {date} may be stale — {N} commits since review"
- For entries without a \`commit\` field (legacy entries): display "Note: {skill} review from {date} has no commit tracking — consider re-running for accurate staleness detection"
- If all reviews match the current HEAD, do not display any staleness notes

### 0B. Collect Plan Sources

```bash
eval $(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')
echo "SLUG: $SLUG"
echo "BRANCH: $BRANCH"

# CEO plan (from /plan-ceo-review EXPANSION or SELECTIVE EXPANSION)
CEO_PLAN=$(ls -t ~/.gstack/projects/$SLUG/ceo-plans/*-*.md 2>/dev/null | head -1)
[ -n "$CEO_PLAN" ] && echo "CEO_PLAN: $CEO_PLAN" || echo "CEO_PLAN: none"

# Test plan (from /plan-eng-review)
TEST_PLAN=$(ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-test-plan-*.md 2>/dev/null | head -1)
[ -n "$TEST_PLAN" ] && echo "TEST_PLAN: $TEST_PLAN" || echo "TEST_PLAN: none"

# Design doc (from /office-hours or /plan-ceo-review promotion)
DESIGN_DOC=$(ls -t docs/designs/*.md 2>/dev/null | head -1)
[ -z "$DESIGN_DOC" ] && DESIGN_DOC=$(ls -t ~/.gstack/projects/$SLUG/*-design-*.md 2>/dev/null | head -1)
[ -n "$DESIGN_DOC" ] && echo "DESIGN_DOC: $DESIGN_DOC" || echo "DESIGN_DOC: none"

# Review log
cat ~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl 2>/dev/null || echo "NO_REVIEWS"
```

Read every artifact that exists. These are the primary inputs for implementation:

1. **CEO plan** — vision, accepted scope, deferred items, scope decisions
2. **Eng review** — architecture decisions, failure modes, test diagram, performance concerns
3. **Test plan** — affected pages/routes, key interactions, edge cases, critical paths
4. **Design doc** — if promoted from CEO review or created by /office-hours

Also read:
- `CLAUDE.md` — project conventions, test commands, architecture notes
- `TODOS.md` — related items that may be addressed by this build
- The conversation plan — if the user has a plan in the current conversation

### 0C. Plan Validation

**If no plan found anywhere** (no CEO plan, no eng review, no conversation plan):
Use AskUserQuestion:
- "No reviewed plan found. /build needs a plan to execute. What would you like to do?"
- A) Describe the plan now (I'll decompose it into tasks)
- B) Run /plan-eng-review first (recommended for non-trivial work)
- C) Abort

**If eng review exists but has status "issues_open":**
Use AskUserQuestion:
- "The eng review has unresolved issues. Building on an incomplete review risks rework."
- A) Build anyway — I'll handle issues as they come up
- B) Abort — run /plan-eng-review again to resolve issues first
- RECOMMENDATION: Choose B if critical_gaps > 0, Choose A if only informational issues remain

**If plan found:** Continue to Step 1.

---

## Step 1: Task Decomposition

Analyze the plan and break it into discrete, implementable tasks. This is
the most important step — good decomposition enables parallel execution.

### 1A. Identify Work Units

Read the plan and extract every concrete piece of work. A work unit is:
- A single file or tightly-coupled group of files
- Independently testable
- Has clear inputs and outputs

Categorize each work unit:

```
WORK UNIT DECOMPOSITION
═══════════════════════════════════════════════════════════
#  | Category       | Description                | Depends on | Est. size
---|----------------|----------------------------|------------|----------
1  | infrastructure | Add database migration     | —          | S
2  | backend        | Create FooService          | 1          | M
3  | backend        | Add API endpoint           | 2          | S
4  | frontend       | Build FooComponent         | 3          | M
5  | test           | Unit tests for FooService  | 2          | S
6  | test           | Integration test for API   | 3          | S
7  | test           | E2E test for full flow     | 4          | M
═══════════════════════════════════════════════════════════
```

### 1B. Determine Parallelism

Draw a dependency graph to identify what can run in parallel:

```
     1 (migration)
         │
     2 (service)
       ┌───┴───┐
  3 (API)    5 (unit tests)
    │
  4 (component)    6 (integration tests)
    │
  7 (E2E tests)
```

Group tasks into waves — each wave runs in parallel, waves run sequentially:
- **Wave 1:** All tasks with no dependencies
- **Wave 2:** Tasks whose dependencies were in Wave 1
- **Wave 3:** Tasks whose dependencies were in Wave 2
- etc.

### 1C. Determine Team Composition

Based on the work units, determine how many agents you need. Rules:

- **1 agent** (no team needed): Total work < 5 tasks OR all tasks are sequential
  with no parallelism opportunity. Skip TeamCreate — just implement directly.
- **2 agents:** Plan has both backend and frontend work, or backend and test work
  that can overlap.
- **3 agents:** Plan has backend + frontend + significant test coverage work.
- **4 agents (max):** Large plan with infrastructure + backend + frontend + tests,
  all with significant parallel opportunity.

**Never spawn more agents than there are parallel work streams.** Agents that
sit idle waiting for dependencies are waste, not throughput.

Use AskUserQuestion to confirm the plan:
- Show the work unit table and dependency graph
- Show the proposed team size and wave structure
- RECOMMENDATION: State the team size and why
- A) Proceed with proposed plan
- B) Adjust (let user modify)
- C) Skip teams — I'll implement sequentially (for small plans)

---

## Step 2: Team Assembly

**If single-agent mode** (Step 1C chose option C or 1 agent): Skip to Step 4-solo.

### 2A. Create the Team

```
Use TeamCreate:
  team_name: "build-{feature-slug}"
  description: "Implementing {feature name} per reviewed plan"
```

### 2B. Create Tasks

For each work unit from Step 1A, create a task:

```
Use TaskCreate for each work unit:
  title: "{category}: {description}"
  description: Include:
    - What to build (specific files, classes, methods)
    - Architecture decisions from the eng review
    - Conventions from CLAUDE.md
    - Dependencies (which tasks must complete first)
    - Acceptance criteria (what "done" means)
    - Test expectations (what tests to write alongside)
```

**Task descriptions must be self-contained.** Each agent reads only its task — it
does not have the full plan context. Include everything the agent needs: file paths,
method signatures, data structures, error handling expectations, test patterns.

### 2C. Spawn Agents

Spawn agents for each role identified in Step 1C. Use the Agent tool with:
- `team_name`: the team name from 2A
- `name`: a descriptive role name (e.g., "backend", "frontend", "tests")
- `subagent_type`: "general-purpose" (agents need write access)

Give each agent a focused prompt:

```
You are the {role} agent on a build team implementing {feature}.
Your team name is "{team-name}".

Your job:
1. Check TaskList for tasks assigned to you
2. Implement each task following the project conventions in CLAUDE.md
3. Write tests alongside your implementation (not as a separate step)
4. Mark tasks completed via TaskUpdate when done
5. If blocked, send a message to the team lead explaining what you need

Code standards (non-negotiable):
- Every line of code is a liability. Write the minimum that is obviously correct.
- Earn every abstraction, every file, every dependency. Less is more.
- Explicit over clever. Names are documentation. Error paths are real code.
- No dead code, no commented-out blocks, no unused imports.
- Validate at system boundaries, trust internal data.

Conventions:
- Read existing code patterns before writing new code
- Follow the project's naming, file structure, and test conventions
- Commit each task as a separate logical commit (bisectable)
- Never force push or amend commits from other agents

{Include relevant CLAUDE.md conventions here}
```

### 2D. Assign Wave 1

Assign all Wave 1 tasks (those with no dependencies) to the appropriate agents
using TaskUpdate with the `owner` field.

---

## Step 3: Orchestrate

Monitor the team and manage the build process.

### 3A. Wave Progression

After agents complete Wave 1 tasks:
1. Check TaskList for completed tasks
2. Identify which Wave 2 tasks are now unblocked
3. Assign unblocked tasks to available agents via TaskUpdate
4. Repeat for each subsequent wave

### 3B. Handle Blockers

When a teammate reports being blocked:

**Implementation ambiguity** (plan doesn't specify something):
- Check the eng review and CEO plan for guidance
- If the answer is there, send it to the teammate via SendMessage
- If not, make the simplest decision consistent with the plan's architecture

**Merge conflicts between agents:**
- Have the agent whose task has fewer changes rebase
- If complex, resolve the conflict yourself

**Test failures:**
- Check if the failure is a real bug or a test environment issue
- If real: assign a fix task to the agent who wrote the code
- If environment: fix it yourself and notify the team

**Dependency not ready:**
- Reassign the blocked agent to a different available task
- Or help the blocking agent finish faster

### 3C. Progress Tracking

After each wave completes, output a progress update:

```
BUILD PROGRESS — Wave {N}/{total} complete
════════════════════════════════════════════
Completed: {N}/{total} tasks
In progress: {N} tasks
Blocked: {N} tasks
Remaining: {N} tasks

{One-line status per active agent}
════════════════════════════════════════════
```

---

## Step 4: Integration & Verification

After all tasks are complete (or in single-agent mode after implementation):

### 4A. Run Tests

```bash
# Detect and run the project's test suite
# Use the test command from CLAUDE.md or detect automatically
```

Run the full test suite. If tests fail:
1. Identify which task's code caused the failure
2. Fix the issue (or assign to the responsible agent)
3. Re-run tests until green

### 4B. Coverage Check

If a test plan exists from the eng review, cross-reference:
- Every "Key Interaction to Verify" has a test
- Every "Edge Case" is covered
- Every "Critical Path" has an integration or E2E test

If gaps exist, write the missing tests.

### 4C. Plan Conformance

Read the original plan one more time. For each accepted scope item:
- Is it implemented? Check the code.
- Is it tested? Check the test suite.
- Does it match the architecture decisions from the eng review?

Flag any deviations as AskUserQuestion:
- "The plan specified X but the implementation does Y. Is this acceptable?"
- A) Accept the deviation (update the plan)
- B) Fix the implementation to match the plan

### 4D. Shutdown Team

If a team was created, shut it down gracefully:

Send each teammate: `message: {type: "shutdown_request"}`

---

## Step 4-solo: Single-Agent Implementation

When the plan is small enough for one agent (no TeamCreate):

1. Implement tasks in dependency order from Step 1A
2. Write tests alongside each piece of implementation
3. Commit each logical unit separately (bisectable)
4. Run the full test suite after all tasks
5. Proceed to Step 5

---

## Step 5: Handoff

### 5A. Build Summary

Output a structured summary:

```
BUILD COMPLETE
═══════════════════════════════════════════════════════
Plan source:     {CEO plan / eng review / conversation}
Team size:       {N agents / solo}
Tasks completed: {N}/{N}
Tests:           {N} passing, {N} failing
Commits:         {N} (bisectable)

FILES CHANGED
─────────────────────────────────────────────────────
{git diff --stat against base branch}

WHAT WAS BUILT
─────────────────────────────────────────────────────
{Bullet list of features/components implemented}

WHAT WAS NOT BUILT (deferred)
─────────────────────────────────────────────────────
{Items from "NOT in scope" in the reviews}

NEXT STEP
─────────────────────────────────────────────────────
Run /ship to test, review, version bump, and open a PR.
═══════════════════════════════════════════════════════
```

### 5B. Persist Build Log

```bash
eval $(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)
mkdir -p ~/.gstack/projects/$SLUG
echo '{"skill":"build","timestamp":"TIMESTAMP","status":"STATUS","tasks_completed":N,"tasks_total":M,"team_size":T}' >> ~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl
```

Substitute:
- **TIMESTAMP**: current ISO 8601 datetime
- **STATUS**: "complete" if all tasks done and tests pass; "partial" if some tasks deferred; "failed" if tests still failing
- **N/M**: completed/total task counts
- **T**: number of agents used (1 for solo mode)

---

## Important Rules

- **Trust the plan.** Do not re-debate decisions made during review. Build what was reviewed.
- **Every line is a liability.** Code is not an asset. The Code Standards section applies to all output — yours and every agent's.
- **Tests are not optional.** Every implementation task includes its tests. No "tests later" commits.
- **Bisectable commits.** Each commit is one logical change. Agents commit their own work.
- **Self-contained task descriptions.** Agents only see their task, not the full plan. Include everything they need.
- **Never spawn idle agents.** More agents than parallel work streams is waste.
- **Single-agent for small plans.** TeamCreate overhead is not worth it for < 5 sequential tasks.
- **Verify against the plan.** The plan is the spec. Deviations require explicit user approval.
- **Hand off to /ship.** /build implements. /ship tests, reviews, versions, and creates the PR.
