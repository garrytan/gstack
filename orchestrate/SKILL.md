---
name: orchestrate
version: 1.0.0
description: |
  Structured workflow orchestration. One command runs the full lifecycle:
  triage → plan → plan review → execute → code review → QA → ship.
  Chains gstack skills (/plan-ceo-review, /plan-eng-review, /review, /qa, /ship, /retro)
  into a disciplined pipeline with phase gates and rejection loops.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

## Update Check (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (AskUserQuestion → upgrade if yes, `touch ~/.gstack/last-update-check` if no). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

# /orchestrate — Structured Workflow Orchestration

You are running the `/orchestrate` workflow. This chains gstack skills into a structured pipeline with phase gates. Each phase must pass before the next begins.

## User-invocable

When the user types `/orchestrate`, run this skill.

## Arguments

- `/orchestrate <task description>` — full pipeline (default)
- `/orchestrate --from <phase> <task>` — resume from a specific phase
- `/orchestrate --skip-retro <task>` — skip the optional retro phase

## Overview

```
/orchestrate "add user authentication"

Phase 1 - Triage    → classify task, assess scope
Phase 2 - Plan      → /plan-ceo-review → /plan-eng-review
Phase 3 - Review    → plan review gate (max 3 rounds)
Phase 4 - Execute   → write code
Phase 5 - Review    → /review code review gate (max 3 rounds)
Phase 6 - QA        → /qa diff-aware testing
Phase 7 - Ship      → /ship automated release
Phase 8 - Retro     → /retro (optional)
```

---

## Phase 1: Triage

Classify the user's request before any work begins.

### Task Type

| Type | Signals | Pipeline |
|------|---------|----------|
| **bug** | "fix", "broken", "error", "crash" | Plan(light) → Execute → Review → QA → Ship |
| **feature** | "add", "implement", "build", "create" | Plan(full) → Execute → Review → QA → Ship |
| **refactor** | "refactor", "restructure", "split", "clean up" | Plan(full) → Execute → Review → QA → Ship |
| **docs** | "document", "update docs", "README" | Plan(light) → Execute → Ship |

### Scope Assessment

Use the same three modes as `/plan-ceo-review`:

| Scope | Description | Pipeline Effect |
|-------|-------------|-----------------|
| **SCOPE EXPANSION** | Task is bigger than it looks — hidden complexity, cross-cutting concerns | Plan phase asks user to confirm/split before proceeding |
| **HOLD SCOPE** | Task is well-defined, proceed normally | Full pipeline, normal rigor |
| **SCOPE REDUCTION** | User wants minimum viable — ship fast, iterate later | Plan light, Review light, QA quick mode |

Output:
```
Triage: type=feature | scope=HOLD SCOPE
Reasoning: <one sentence>
```

Then proceed to Phase 2.

---

## Phase 2: Plan

Run two planning passes in sequence.

### Step 2A: CEO Review

Read `~/.claude/skills/gstack/plan-ceo-review/SKILL.md` and execute `/plan-ceo-review` with the scope mode from Phase 1.

- SCOPE EXPANSION → CEO review in expansion mode (dream big, 10x thinking)
- HOLD SCOPE → CEO review in hold mode (maximum rigor)
- SCOPE REDUCTION → CEO review in reduction mode (ruthless cuts)

### Step 2B: Engineering Review

Read `~/.claude/skills/gstack/plan-eng-review/SKILL.md` and execute `/plan-eng-review`.

This produces: architecture diagram, test matrix, edge cases, implementation steps.

### Step 2C: User Confirmation

Present the combined plan to the user via AskUserQuestion:
- **A) Approve** — proceed to Phase 3
- **B) Modify** — user provides feedback, return to Step 2A with feedback
- **C) Abort** — stop the pipeline

**If SCOPE EXPANSION was detected in Phase 1:** Before presenting the plan, ask the user to confirm the expanded scope or split into smaller tasks.

---

## Phase 3: Plan Review — Roundtable Gate

Review the plan before any code is written. This is a quality gate using **multi-perspective roundtable review** — not a simple checklist. The plan must survive scrutiny from multiple expert viewpoints before execution begins.

### Roundtable Review

Adopt **3 software engineering experts** in sequence to stress-test the plan. All reviewers are engineers — no mixed domains.

| Persona | Known for | Review angle |
|---------|-----------|--------------|
| ✂️ **Linus Torvalds** | Linux kernel, extreme simplicity | Over-engineering? Unnecessary abstraction? Simpler approach? |
| 🔒 **Bryan Cantrill** | DTrace, illumos, systems debugging | Failure modes? Missing error handling? Observability gaps? Hidden dependencies? |
| 🏗️ **Martin Fowler** | Refactoring, software architecture patterns | Correct abstractions? Testable design? Maintainability? Technical debt? |

For each persona, speak in their voice:
```
[Linus Torvalds]: <1-3 simplification challenges>
[Bryan Cantrill]: <1-3 failure mode concerns>
[Martin Fowler]: <1-3 architecture observations>
```

### Gate Decision

After all three perspectives:

| Outcome | Condition | Action |
|---------|-----------|--------|
| **PASS** | No blocking concerns from any perspective | Proceed to Phase 4 |
| **REVISE** | Addressable concerns raised | Return to Phase 2 with specific feedback |
| **ESCALATE** | Fundamental disagreement between perspectives | Ask user to decide |

### Rejection Flow

```
Roundtable finds blocking concerns
  → Summarize concerns from each perspective
  → Return to Phase 2 (re-plan with feedback)
  → Max 3 rounds — if still failing after 3, ask user to intervene
```

Track: `plan_review_rounds: 0 → 1 → 2 → 3 (escalate)`

---

## Phase 4: Execute

Write the code. Follow the plan from Phase 2-3.

**Rules:**
- Stay within the approved plan scope — do not add unplanned features
- Follow existing code style and conventions
- Write tests alongside implementation when the plan calls for it

---

## Phase 5: Code Review (Gate)

Read `~/.claude/skills/gstack/review/SKILL.md` and execute `/review`.

### Classification

`/review` produces findings classified as:

| Classification | Action |
|----------------|--------|
| **VALID** | Must fix. Return to Phase 4 (Execute) to address the issue |
| **ALREADY FIXED** | No action — issue was already addressed in the diff |
| **FALSE POSITIVE** | No action — log the pattern to avoid flagging it again |

### Rejection Flow

```
/review finds VALID issues
  → Return to Phase 4 (fix the code)
  → Re-run /review
  → Max 3 VALID rounds — if still failing, ask user to intervene

Only VALID issues count toward the round limit.
ALREADY FIXED and FALSE POSITIVE do not trigger rejection.
```

Track: `code_review_rounds: 0 → 1 → 2 → 3 (escalate)`

---

## Phase 6: QA

Read `~/.claude/skills/gstack/qa/SKILL.md` and execute `/qa`.

### Mode Selection

Based on Phase 1 triage:

| Scope | QA Mode |
|-------|---------|
| SCOPE EXPANSION | full — systematic exploration of all affected areas |
| HOLD SCOPE | diff-aware (default) — test pages affected by the diff |
| SCOPE REDUCTION | quick — 30-second smoke test |

### Failure Handling

```
/qa reports failures
  → Return to Phase 4 (fix the code)
  → Re-run Phase 5 (code review) if code was changed
  → Re-run Phase 6 (QA)
```

**If no web application is involved** (CLI tool, library, backend-only): Skip browser QA. Run the project's test suite instead:

```bash
# Auto-detect test runner
if [ -f "pytest.ini" ] || [ -f "pyproject.toml" ]; then pytest -x -q
elif [ -f "package.json" ]; then npm test
elif [ -f "Cargo.toml" ]; then cargo test
else echo "No test runner detected — skipping automated QA"
fi
```

---

## Phase 7: Ship

Read `~/.claude/skills/gstack/ship/SKILL.md` and execute `/ship`.

`/ship` handles: sync main → run tests → commit → push → create PR.

**Do not duplicate what `/ship` already does.** Just invoke it.

---

## Phase 8: Retro (Optional)

If the user did not pass `--skip-retro`, read `~/.claude/skills/gstack/retro/SKILL.md` and execute `/retro`.

This analyzes the work just completed: contribution breakdown, code quality metrics, patterns.

---

## Pipeline State

Track these values across phases (in conversation context — no external storage needed):

| Field | Set by | Used by |
|-------|--------|---------|
| `type` | Phase 1 (Triage) | Phase 2 (plan depth), Phase 6 (QA mode) |
| `scope` | Phase 1 (Triage) | Phase 2 (CEO review mode), Phase 6 (QA mode) |
| `plan_review_rounds` | Phase 3 | Phase 3 (escalation at 3) |
| `code_review_rounds` | Phase 5 | Phase 5 (escalation at 3) |

---

## Error Handling

| Situation | Action |
|-----------|--------|
| A gstack skill is not installed | Stop and tell user: "Required skill `/X` not found. Run `cd ~/.claude/skills/gstack && ./setup` to install." |
| User says "skip" during any phase | Skip that phase, continue to next |
| User says "abort" or "stop" | Stop the pipeline immediately |
| Phase gate fails 3 times | Ask user to intervene — do not loop forever |
| Merge conflict in Phase 7 | `/ship` handles this — do not duplicate |

---

## Important Rules

1. **One command, full lifecycle.** The user says `/orchestrate "task"` and the pipeline runs end-to-end.
2. **Phase gates are mandatory.** Phase 3 (plan review) and Phase 5 (code review) are quality gates — do not skip them.
3. **Respect scope.** SCOPE REDUCTION means less work, not lower quality. SCOPE EXPANSION means more ambition, confirmed by the user.
4. **Do not duplicate skill logic.** Each phase calls the corresponding gstack skill. Do not reimplement what `/review`, `/qa`, or `/ship` already do.
5. **Escalate, don't loop.** Max 3 rejection rounds at any gate. After 3, ask the user.
6. **Progress updates.** At each phase transition, output a one-line status: `Phase N → Phase N+1: <reason>`
