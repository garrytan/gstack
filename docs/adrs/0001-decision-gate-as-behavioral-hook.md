---
number: 0001
title: Decision gate as behavioral hook, not post-hoc detection
status: accepted
date: 2026-03-27
tags: [decision-gate, architecture, core-design]
trigger_conditions:
  - "If gstack adds a cross-skill invocation mechanism that would allow true subroutine calls between skills"
  - "If dogfood data shows the behavioral hook pattern causes unacceptable interruption rates even on liberal sensitivity"
---

# 0001. Decision Gate as Behavioral Hook, Not Post-Hoc Detection

## Status

Accepted

## Context

The `/adr` skill needs to catch architectural decisions that happen in the flow of work — not just decisions the user deliberately sits down to document. The question is: when does the agent surface the decision?

Three approaches were considered. The gstack architecture constrains the options: skills are prompt templates in SKILL.md files. They read each other's file artifacts but cannot invoke each other as subroutines. There is no mechanism for one skill to pause, spawn another skill, get a result, and resume.

Additionally, many architectural decisions are irreversible or expensive to reverse. The timing of when the decision is surfaced has direct consequences for whether the thinking can still change the outcome.

## Decision

Implement the decision gate as a behavioral hook — the same pattern as `/careful` — that fires inline during normal agent operation when the agent is about to make an architectural choice. The agent pauses before implementing, explains what it's about to do, and gets user input before proceeding.

## Alternatives Considered

### Alternative: Inline scratch notes with formal ADR later (Option A)
- **Description:** Agent recognizes a decision point mid-work, appends a brief note to a scratch file (`docs/adr/PENDING.md`), and continues coding. At session end or during `/review`, pending notes are triaged — promoted to full ADRs or discarded.
- **Advantages:** Zero interruption during coding flow. Low friction. Captures at least a breadcrumb trail.
- **Disadvantages:** ADRs are written after the code, when the decision has already been made and the code already exists. The thinking happens too late to change the outcome.
- **Ruling rationale:** Produces backfilled ADRs. A backfilled ADR is a rationalization wearing the skin of a decision record — it has the sections and the tradeoffs, but the tradeoffs were narrated after the fact, not weighed before the commitment. Sunk cost fallacy makes it psychologically impossible to conclude "we should undo this" when the code is already written and working.

### Alternative: Post-hoc detection during `/review` (Option B)
- **Description:** `/review` scans the diff for architectural implications — new dependencies, API changes, schema changes — and flags undocumented decisions, recommending the user run `/adr litmus-test` before merging.
- **Advantages:** No interruption during coding. Catches decisions at a natural review checkpoint. Leverages existing `/review` infrastructure.
- **Disadvantages:** Same backfill problem as Option A. By the time `/review` runs, the code is written, the tests pass, the PR is open. The human incentive is to justify the decision, not reconsider it. Additionally, it makes it easy for the human to rationalize not going back: "the system is built and the walls haven't come crashing down."
- **Ruling rationale:** Same fundamental flaw as Option A — the thinking happens after the commitment, not before it.

### Alternative: True cross-skill invocation (Option C)
- **Description:** Add a gstack architecture feature (e.g., a `CALLS:` directive in SKILL.md) that lets one skill invoke another as a subroutine. The agent could call `/adr litmus-test` mid-implementation, get a result, and resume.
- **Advantages:** Clean separation of concerns. Each skill remains modular. Most powerful option.
- **Disadvantages:** Requires a gstack platform architecture change, not just a skill feature. Significant implementation effort. Scope far exceeds a single-skill PR.
- **Ruling rationale:** Right idea, wrong scope. Noted as a future gstack-level TODO. The behavioral hook achieves the critical goal (pre-implementation decision surfacing) without requiring platform changes.

## Tradeoffs

**Technical tradeoffs:**
- **What we gain:** Decisions are surfaced before implementation, when the thinking can still change the outcome.
- **What we lose:** The agent interrupts the coding flow. This is a real cost to the user experience.
- **Why this tradeoff is acceptable:** The risk is asymmetric. A missed decision (false negative) costs the same as not having the feature. An unnecessary interruption (false positive) costs a "skip." Conservative default is rational. Additionally, the user can tune sensitivity to liberal for established architectures.

**Team and hiring tradeoffs:**
- **What we gain:** Decision records written by someone (the agent + human) who is making the decision in the moment, not reconstructing it later.
- **What we lose:** Nothing — this is strictly better than post-hoc.

**Business and operational tradeoffs:**
- **What we gain:** Architectural decisions are documented at the moment of maximum information and minimum sunk cost.
- **What we lose:** Slightly slower coding sessions due to interruptions. For a solo founder, this is the user's own time. For a team, this is shared architectural discipline.
- **Why this tradeoff is acceptable:** The cost of an undocumented bad architectural decision (weeks of rework when you discover the problem) dwarfs the cost of a 2-minute pause to think about whether this is the right call.

## Consequences

- The decision gate becomes a core behavioral feature, not just an ADR mode. It must be integrated into the agent's general operation, not just invoked when the user thinks to run `/adr`.
- The `/careful` pattern proves the mechanism works. The decision gate is the second behavioral hook in gstack, establishing a pattern for future hooks.
- The "ADR before code" constraint is the hardest behavioral requirement to enforce. The agent must be instructed not to write implementation code until the ADR is complete when the user chooses to document a decision.
- The skip log (`docs/adr/SKIPPED.md`) becomes an important feedback artifact for tuning the gate over time.
- Future gstack contributors may be tempted to make the gate auto-generate ADRs without human input. This would defeat the purpose — see ADR-0002.

## Trigger Conditions

- If gstack adds a cross-skill invocation mechanism, re-evaluate whether the behavioral hook should be replaced with a true skill call.
- If dogfood data shows the hook causes unacceptable interruption rates (>50% skip rate on conservative, or user complaints about flow disruption) even after trigger pattern tuning.
