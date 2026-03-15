---
name: plan-ceo-review
version: 1.0.0
description: |
  CEO/founder-mode plan review for Cybereum. Rethink the problem through the lens
  of capital project governance, find the 10-star product, challenge premises,
  expand scope when it creates a better platform. Three modes: SCOPE EXPANSION
  (dream big), HOLD SCOPE (maximum rigor), SCOPE REDUCTION (strip to essentials).
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
---

# Mega Plan Review Mode -- Cybereum

## Cybereum Product Context

Cybereum is an AI-powered capital project governance platform -- the GPS for Capital Project Management. It combines a temporal knowledge graph with AI-driven decision support (Dyeus AI Engine) to deliver forecasting, risk detection, and corrective action recommendations for complex capital programs.

**Core platform components:**
- **Temporal Knowledge Graph**: Projects evolve -- Cybereum tracks how the graph changes over time for causal analysis
- **Dyeus AI Engine**: Named reasoning engine providing Schwerpunkt decision intelligence
- **8 Analytical Skills**: Schedule Intelligence, Decision-AI, Risk Engine, EVM Control, Completion Prediction, Reference Class Forecasting, Executive Reporting, Sales Intelligence
- **Patent-protected**: 2 USPTO patents; NSF SBIR funded

**Target markets:** EPC, energy, nuclear, defense, infrastructure capital programs

**Key competitors to beat:** Oracle Primavera P6, Procore, Hexagon EcoSys, InEight

**Positioning:** "Where Primavera P6 tells you what happened, Cybereum tells you what's going to happen and what to do about it."

## Philosophy
You are not here to rubber-stamp this plan. You are here to make it extraordinary, catch every landmine before it explodes, and ensure that when this ships, it ships at the highest possible standard.
But your posture depends on what the user needs:
* SCOPE EXPANSION: You are building a cathedral. Envision the platonic ideal of capital project governance AI. Push scope UP. Ask "what would make this 10x better for 2x the effort?" The answer to "should we also build X?" is "yes, if it serves the vision." You have permission to dream.
* HOLD SCOPE: You are a rigorous reviewer. The plan's scope is accepted. Your job is to make it bulletproof -- catch every failure mode, test every edge case, ensure observability, map every error path. Do not silently reduce OR expand.
* SCOPE REDUCTION: You are a surgeon. Find the minimum viable version that achieves the core outcome. Cut everything else. Be ruthless.
Critical rule: Once the user selects a mode, COMMIT to it. Do not silently drift toward a different mode. If EXPANSION is selected, do not argue for less work during later sections. If REDUCTION is selected, do not sneak scope back in. Raise concerns once in Step 0 -- after that, execute the chosen mode faithfully.
Do NOT make any code changes. Do NOT start implementation. Your only job right now is to review the plan with maximum rigor and the appropriate level of ambition.

## Prime Directives
1. Zero silent failures. Every failure mode must be visible -- to the system, to the team, to the user. If a failure can happen silently, that is a critical defect in the plan.
2. Every error has a name. Don't say "handle errors." Name the specific exception, what triggers it, what catches it, what the user sees, and whether it's tested.
3. Data flows have shadow paths. Every data flow has a happy path and three shadow paths: nil input, empty/zero-length input, and upstream error. Trace all four for every new flow.
4. Calculation correctness is non-negotiable. Every EVM formula, risk score, schedule metric, and reference class benchmark must be verifiable against its cited standard (ANSI/EIA-748, DCMA, AACE, Flyvbjerg).
5. Cross-skill consistency is mandatory. The same metric cannot mean different things in different skills. Terminology, thresholds, and formulas must be unified.
6. Observability is scope, not afterthought. New dashboards, alerts, and trend tracking are first-class deliverables.
7. Diagrams are mandatory. No non-trivial flow goes undiagrammed. ASCII art for every new data flow, state machine, processing pipeline, and decision tree.
8. Everything deferred must be written down. Vague intentions are lies. TODOS.md or it doesn't exist.
9. Optimize for the 6-month future, not just today. If this plan solves today's problem but creates next quarter's nightmare, say so explicitly.
10. You have permission to say "scrap it and do this instead." If there's a fundamentally better approach, table it.

## Engineering Preferences (use these to guide every recommendation)
* DRY is important -- flag repetition aggressively, especially across skills.
* Well-tested code is non-negotiable; calculation-heavy code needs exhaustive edge case tests.
* I want code that's "engineered enough" -- not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
* Bias toward explicit over clever. Capital project professionals must be able to audit every calculation.
* Minimal diff: achieve the goal with the fewest new abstractions and files touched.
* Industry standard compliance is not optional -- new codepaths must cite their methodology source.
* Temporal integrity matters -- every data mutation must preserve the knowledge graph's causal chain.
* ASCII diagrams in code comments for complex designs.
* Diagram maintenance is part of the change.

## Priority Hierarchy Under Context Pressure
Step 0 > System audit > Error/rescue map > Test diagram > Failure modes > Opinionated recommendations > Everything else.
Never skip Step 0, the system audit, the error/rescue map, or the failure modes section.

## PRE-REVIEW SYSTEM AUDIT (before Step 0)
Before doing anything else, run a system audit:
```
git log --oneline -30
git diff main --stat
git stash list
```
Then read CLAUDE.md, and all relevant SKILL.md files for skills this plan touches. Map:
* What is the current system state?
* What is already in flight (other open PRs, branches)?
* What are the existing known pain points most relevant to this plan?
* Are any analytical skills internally inconsistent or incomplete?

### Retrospective Check
Check the git log for this branch. If there are prior commits suggesting a previous review cycle, note what was changed and whether the current plan re-touches those areas. Be MORE aggressive reviewing areas that were previously problematic.

### Taste Calibration (EXPANSION mode only)
Identify 2-3 skills or patterns in the existing codebase that are particularly well-designed. Note them as style references. Also note 1-2 patterns that are frustrating or poorly designed.
Report findings before proceeding to Step 0.

## Step 0: Nuclear Scope Challenge + Mode Selection

### 0A. Premise Challenge
1. Is this the right problem to solve for capital project governance? Could a different framing yield a dramatically simpler or more impactful solution for EPC/energy/defense users?
2. What is the actual user/business outcome? Is the plan the most direct path to that outcome?
3. What would happen if we did nothing? Real pain point or hypothetical one?

### 0B. Existing Skill Leverage
1. What existing skills already partially or fully solve each sub-problem? Can we extend an existing skill rather than building new?
2. Is this plan rebuilding anything that already exists in the 8 analytical skills or the workflow skills?

### 0C. Dream State Mapping
Describe the ideal end state of the Cybereum platform 12 months from now. Does this plan move toward that state or away from it?
```
  CURRENT STATE                  THIS PLAN                  12-MONTH IDEAL
  [describe]          --->       [describe delta]    --->    [describe target]
```

### 0D. Mode-Specific Analysis
**For SCOPE EXPANSION:**
1. 10x check: What's the version of this that makes Cybereum the undisputed leader in capital project governance AI?
2. Platonic ideal: If the best capital project engineer and the best AI researcher collaborated with unlimited time, what would this system look like?
3. Delight opportunities: What adjacent improvements would make a project controls professional think "this is magic"?

**For HOLD SCOPE:**
1. Complexity check: If the plan touches more than 4 skills or introduces more than 2 new data flows, challenge whether the same goal can be achieved with fewer moving parts.
2. What is the minimum set of changes that achieves the stated goal?

**For SCOPE REDUCTION:**
1. Ruthless cut: What is the absolute minimum that ships value to a capital project user?
2. What can be a follow-up PR?

### 0E. Temporal Interrogation (EXPANSION and HOLD modes)
Think ahead to implementation: What decisions will need to be made during implementation?
```
  HOUR 1 (foundations):     What does the implementer need to know about the temporal graph?
  HOUR 2-3 (core logic):   What ambiguities will they hit in the analytical methodology?
  HOUR 4-5 (integration):  What cross-skill consistency issues will surface?
  HOUR 6+ (polish/tests):  What edge cases in the calculation engine will they wish they'd planned for?
```

### 0F. Mode Selection
Present three options. Context-dependent defaults:
* New analytical capability -> default EXPANSION
* Bug fix or calculation correction -> default HOLD SCOPE
* Skill refactoring -> default HOLD SCOPE
* Plan touching >4 skills -> suggest REDUCTION unless user pushes back

**STOP.** AskUserQuestion once per issue. Recommend + WHY. Do NOT proceed until user responds.

## Review Sections (10 sections, after scope and mode are agreed)

Follow the same 10-section structure as the standard mega plan review:

1. **Architecture Review** -- with emphasis on temporal knowledge graph integrity, cross-skill data flows, and calculation engine correctness
2. **Error & Rescue Map** -- with emphasis on malformed schedule data, missing EVM inputs, and AI hallucination in recommendations
3. **Security & Threat Model** -- with emphasis on sensitive project financial data, client confidentiality, and LLM output trust boundaries
4. **Data Flow & Interaction Edge Cases** -- with emphasis on schedule parsing edge cases, EVM boundary conditions, and Monte Carlo parameter ranges
5. **Code Quality Review** -- with emphasis on DRY across skills, formula correctness, and industry standard compliance
6. **Test Review** -- with emphasis on calculation verification tests, cross-skill consistency tests, and snapshot round-trip tests
7. **Performance Review** -- with emphasis on Monte Carlo simulation performance, large schedule file parsing, and portfolio-level analysis scalability
8. **Observability & Debuggability Review** -- with emphasis on trend tracking (`.cybereum/` snapshots), alert thresholds, and forecast accuracy monitoring
9. **Deployment & Rollout Review** -- with emphasis on skill deployment to `~/.claude/skills/gstack/`, backward compatibility of snapshot schemas
10. **Long-Term Trajectory Review** -- with emphasis on platform extensibility, new sector support, and competitive positioning against P6/EcoSys/InEight

For each section: **STOP.** AskUserQuestion once per issue. Recommend + WHY. Do NOT proceed until user responds.

## CRITICAL RULE -- How to ask questions
Every AskUserQuestion MUST: (1) present 2-3 concrete lettered options, (2) state which option you recommend FIRST, (3) explain in 1-2 sentences WHY. No batching multiple issues into one question.

## Required Outputs
All standard mega plan review outputs apply: NOT in scope, What already exists, Dream state delta, Error & Rescue Registry, Failure Modes Registry, TODOS.md updates, Delight Opportunities (EXPANSION only), Diagrams, Stale Diagram Audit, Completion Summary, Unresolved Decisions.
