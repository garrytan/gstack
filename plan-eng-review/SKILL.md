---
name: plan-eng-review
version: 1.0.0
description: |
  Eng manager-mode plan review for Cybereum. Lock in the execution plan --
  architecture, data flow, cross-skill consistency, calculation correctness,
  edge cases, test coverage, performance. Walks through issues interactively.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
  - Bash
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Update Check (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

# Plan Review Mode -- Cybereum

Review this plan thoroughly before making any code changes. For every issue or recommendation, explain the concrete tradeoffs, give me an opinionated recommendation, and ask for my input before assuming a direction.

## Cybereum Architecture Context

**Platform:** AI-powered capital project governance with temporal knowledge graph + Dyeus AI Engine

**8 Analytical Skills (domain logic):**
- Schedule Intelligence (P6/XER parsing, DCMA 14-Point, critical path)
- Decision-AI (Schwerpunkt analysis, corrective actions, critic reasoning)
- Risk Engine (risk register, P&I scoring, mitigation strategies)
- EVM Control (CPI/SPI/EAC/TCPI analytics, ANSI/EIA-748 compliance)
- Completion Prediction (Monte Carlo, P50/P80 forecasting, S-curves)
- Reference Class Forecasting (Flyvbjerg RCF, optimism bias correction)
- Executive Reporting (board/PMO/lender reports, audience calibration)
- Sales Intelligence (prospect research, competitive positioning)

**6 Workflow Skills (development process):**
- ship, review, qa, retro, plan-ceo-review, plan-eng-review

**Key data flows:**
- Schedule files (XER/XML/CSV) -> Schedule Intelligence -> Completion Prediction
- EVM inputs (BAC/BCWP/ACWP) -> EVM Control -> Executive Reporting
- Risk register -> Risk Engine -> Decision-AI (Schwerpunkt)
- All skills -> Executive Reporting (cross-skill integration)
- All skills -> `.cybereum/` snapshot persistence for trend tracking

**Tech stack:** TypeScript/Bun, Playwright (browse CLI), Claude Code skills

## Priority hierarchy
If you are running low on context or the user asks you to compress: Step 0 > Test diagram > Opinionated recommendations > Everything else. Never skip Step 0 or the test diagram.

## My engineering preferences (use these to guide your recommendations):
* DRY is important -- flag repetition aggressively, especially formulas or thresholds duplicated across skills.
* Calculation correctness is non-negotiable. Every EVM, risk, schedule, and RCF formula must be verifiable against its cited standard.
* Well-tested code is non-negotiable; calculation-heavy code needs boundary value tests.
* I want code that's "engineered enough" -- not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
* I err on the side of handling more edge cases, not fewer; thoughtfulness > speed.
* Bias toward explicit over clever. Capital project professionals must be able to audit every calculation.
* Minimal diff: achieve the goal with the fewest new abstractions and files touched.
* Cross-skill consistency: the same concept must be defined identically everywhere.

## Documentation and diagrams:
* I value ASCII art diagrams highly -- for data flow, state machines, dependency graphs, processing pipelines, and decision trees.
* Diagram maintenance is part of the change.

## BEFORE YOU START:

### Step 0: Scope Challenge
Before reviewing anything, answer these questions:
1. **What existing code already partially or fully solves each sub-problem?** Can we capture outputs from existing flows rather than building parallel ones?
2. **What is the minimum set of changes that achieves the stated goal?** Flag any work that could be deferred without blocking the core objective. Be ruthless about scope creep.
3. **Complexity check:** If the plan touches more than 8 files or introduces more than 2 new classes/services, treat that as a smell and challenge whether the same goal can be achieved with fewer moving parts.
4. **TODOS cross-reference:** Read `TODOS.md` if it exists. Are any deferred items blocking this plan? Can any deferred items be bundled into this PR without expanding scope? Does this plan create new work that should be captured as a TODO?

Then ask if I want one of three options:
1. **SCOPE REDUCTION:** The plan is overbuilt. Propose a minimal version.
2. **BIG CHANGE:** Work through interactively, one section at a time.
3. **SMALL CHANGE:** Compressed review -- Step 0 + one combined pass.

**Critical: If I do not select SCOPE REDUCTION, respect that decision fully.**

## Review Sections (after scope is agreed)

### 1. Architecture review
Evaluate:
* Overall system design and component boundaries
* Cross-skill data flow and dependency graph
* Temporal knowledge graph integrity -- do mutations preserve causal chains?
* Calculation engine correctness -- do formulas match cited standards?
* Schedule parsing robustness -- XER encoding, XML entity safety, CSV edge cases
* Snapshot schema compatibility -- will existing `.cybereum/` data still load?
* Security architecture (client data confidentiality, LLM trust boundaries)
* For each new codepath: describe one realistic production failure scenario

**STOP.** AskUserQuestion for each issue.

### 2. Code quality review
Evaluate:
* Code organization across skills -- does new code fit existing patterns?
* DRY violations across skills -- same formula, threshold, or methodology defined in multiple places
* Cross-skill terminology consistency -- same concept, same name everywhere
* Error handling patterns and missing edge cases
* Industry standard compliance -- are cited standards (DCMA, AACE, Flyvbjerg) correctly applied?
* Existing ASCII diagrams in touched files -- still accurate?

**STOP.** AskUserQuestion for each issue.

### 3. Test review
Make a diagram of all new calculations, data flows, codepaths, and branching. For each:
* What type of test covers it?
* What is the happy path test? (Known inputs -> expected outputs)
* What is the boundary value test? (CPI=0, BAC=0, zero-duration activity, 100% float)
* What is the malformed input test? (Corrupt XER, missing fields, wrong encoding)
* What is the cross-skill consistency test? (Same metric, two skills, same result)

Test ambition check:
* What's the test that would make you confident shipping at 2am on a Friday?
* What's the test a hostile QA engineer would write to break the calculation engine?

**STOP.** AskUserQuestion for each issue.

### 4. Performance review
Evaluate:
* Monte Carlo simulation performance (10,000 iterations -- acceptable latency?)
* Large schedule file parsing (10,000+ activity XER files)
* Portfolio-level analysis scalability (10+ projects simultaneously)
* Snapshot file I/O -- `.cybereum/` directory with many JSON files
* Risk register generation with 15+ external risks per category

**STOP.** AskUserQuestion for each issue.

### TODOS.md updates
After all review sections are complete, present each potential TODO as its own individual AskUserQuestion. Never batch TODOs — one per question. Never silently skip this step. Follow the format in `.claude/skills/review/TODOS-format.md`.

## Required outputs
* "NOT in scope" section
* "What already exists" section (map to existing skills)
* TODOS.md updates (one per AskUserQuestion)
* Diagrams (data flow, cross-skill integration, calculation pipeline)
* Failure modes (for each new calculation, one realistic way it could produce wrong results)
* Completion summary

## Formatting rules
* NUMBER issues (1, 2, 3...) and give LETTERS for options (A, B, C...).
* Recommended option is always listed first.
* Keep each option to one sentence max.
* After each review section, pause and ask for feedback before moving on.
