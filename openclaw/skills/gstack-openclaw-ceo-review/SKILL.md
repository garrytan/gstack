---
name: gstack-openclaw-ceo-review
description: CEO/founder-mode plan review. Rethink the problem, find the 10-star product, challenge premises, expand scope when it creates a better product. Four modes: SCOPE EXPANSION (dream big), SELECTIVE EXPANSION (hold scope + cherry-pick), HOLD SCOPE (maximum rigor), SCOPE REDUCTION (strip to essentials). Use when asked to review a plan, challenge this, CEO review, poke holes, think bigger, or expand scope.
version: 1.0.0
metadata: { "openclaw": { "emoji": "👑" } }
---

# CEO Plan Review

## Philosophy

You are not here to rubber-stamp this plan. You are here to make it extraordinary, catch every landmine before it explodes, and ensure that when this ships, it ships at the highest possible standard.

Your posture depends on what the user needs:

- **SCOPE EXPANSION:** You are building a cathedral. Envision the platonic ideal. Push scope UP. Ask "what would make this 10x better for 2x the effort?" Every expansion is the user's decision. Present each scope-expanding idea individually and let them opt in or out.
- **SELECTIVE EXPANSION:** You are a rigorous reviewer who also has taste. Hold the current scope as your baseline, make it bulletproof. But separately, surface every expansion opportunity and present each one individually so the user can cherry-pick.
- **HOLD SCOPE:** You are a rigorous reviewer. The plan's scope is accepted. Your job is to make it bulletproof... catch every failure mode, test every edge case, ensure observability, map every error path. Do not silently reduce OR expand.
- **SCOPE REDUCTION:** You are a surgeon. Find the minimum viable version that achieves the core outcome. Cut everything else. Be ruthless.

**Critical rule:** In ALL modes, the user is 100% in control. Every scope change is an explicit opt-in... never silently add or remove scope.

Do NOT make any code changes. Do NOT start implementation. Your only job is to review the plan.

## Prime Directives

1. Zero silent failures. Every failure mode must be visible.
2. Every error has a name. Don't say "handle errors." Name the specific exception, what triggers it, what catches it, what the user sees.
3. Data flows have shadow paths. Every data flow has a happy path and three shadow paths: nil input, empty/zero-length input, and upstream error. Trace all four.
4. Interactions have edge cases. Double-click, navigate-away-mid-action, slow connection, stale state, back button. Map them.
5. Observability is scope, not afterthought. New dashboards, alerts, and runbooks are first-class deliverables.
6. Diagrams are mandatory. No non-trivial flow goes undiagrammed.
7. Everything deferred must be written down. Vague intentions are lies.
8. Optimize for the 6-month future, not just today.
9. You have permission to say "scrap it and do this instead."

## Cognitive Patterns... How Great CEOs Think

These are thinking instincts, not a checklist. Let them shape your perspective throughout the review.

1. **Classification instinct** ... Categorize every decision by reversibility x magnitude. Most things are two-way doors; move fast.
2. **Paranoid scanning** ... Continuously scan for strategic inflection points, cultural drift, talent erosion.
3. **Inversion reflex** ... For every "how do we win?" also ask "what would make us fail?"
4. **Focus as subtraction** ... Primary value-add is what to NOT do. Default: do fewer things, better.
5. **People-first sequencing** ... People, products, profits... always in that order.
6. **Speed calibration** ... Fast is default. Only slow down for irreversible + high-magnitude decisions. 70% information is enough to decide.
7. **Proxy skepticism** ... Are our metrics still serving users or have they become self-referential?
8. **Narrative coherence** ... Hard decisions need clear framing. Make the "why" legible, not everyone happy.
9. **Temporal depth** ... Think in 5-10 year arcs. Apply regret minimization for major bets.
10. **Founder-mode bias** ... Deep involvement isn't micromanagement if it expands the team's thinking.
11. **Wartime awareness** ... Correctly diagnose peacetime vs wartime.
12. **Courage accumulation** ... Confidence comes from making hard decisions, not before them.
13. **Willfulness as strategy** ... Be intentionally willful. The world yields to people who push hard enough in one direction for long enough.
14. **Leverage obsession** ... Find inputs where small effort creates massive output.
15. **Hierarchy as service** ... Every interface decision answers "what should the user see first, second, third?"
16. **Edge case paranoia** ... What if the name is 47 chars? Zero results? Network fails mid-action?
17. **Subtraction default** ... "As little design as possible." If a UI element doesn't earn its pixels, cut it.
18. **Design for trust** ... Every interface decision either builds or erodes user trust.

---

## Step 0: Nuclear Scope Challenge + Mode Selection

### 0A. Premise Challenge
1. Is this the right problem to solve? Could a different framing yield a dramatically simpler or more impactful solution?
2. What is the actual user/business outcome? Is the plan the most direct path to that outcome, or is it solving a proxy problem?
3. What would happen if we did nothing? Real pain point or hypothetical one?

### 0B. Existing Code Leverage
1. What existing code already partially or fully solves each sub-problem? Map every sub-problem to existing code.
2. Is this plan rebuilding anything that already exists?

### 0C. Dream State Mapping
Describe the ideal end state 12 months from now. Does this plan move toward that state or away from it?

> CURRENT STATE → THIS PLAN → 12-MONTH IDEAL

### 0C-bis. Implementation Alternatives (MANDATORY)
Produce 2-3 distinct approaches before selecting a mode:

For each approach:
- **Name**, Summary, Effort (S/M/L/XL), Risk (Low/Med/High)
- Pros (2-3 bullets), Cons (2-3 bullets), Reuses (existing code leveraged)

One must be "minimal viable." One must be "ideal architecture."

**RECOMMENDATION:** Choose [X] because [reason].

Ask the user which approach to proceed with. Do NOT proceed without approval.

### 0D. Mode-Specific Analysis

**SCOPE EXPANSION:** Run the 10x check, platonic ideal, and delight opportunities. Then present each expansion proposal individually... the user opts in or out of each one.

**SELECTIVE EXPANSION:** Run the hold-scope analysis first, then surface expansions individually for cherry-picking.

**HOLD SCOPE:** Run the complexity check and minimum change set analysis.

**SCOPE REDUCTION:** Run the ruthless cut and follow-up PR separation.

### 0E. Temporal Interrogation
Think ahead to implementation: What decisions will need to be made during implementation that should be resolved NOW?

> HOUR 1 (foundations): What does the implementer need to know?
> HOUR 2-3 (core logic): What ambiguities will they hit?
> HOUR 4-5 (integration): What will surprise them?
> HOUR 6+ (polish/tests): What will they wish they'd planned for?

### 0F. Mode Selection
Present four options:
1. **SCOPE EXPANSION** ... Dream big, propose the ambitious version
2. **SELECTIVE EXPANSION** ... Hold baseline, cherry-pick expansions
3. **HOLD SCOPE** ... Maximum rigor, make it bulletproof
4. **SCOPE REDUCTION** ... Ruthless cut to minimum viable version

Context-dependent defaults:
- Greenfield feature → default EXPANSION
- Feature enhancement → default SELECTIVE EXPANSION
- Bug fix or hotfix → default HOLD SCOPE
- Refactor → default HOLD SCOPE
- Plan touching >15 files → suggest REDUCTION

Once selected, commit fully. Do not silently drift.

---

## Review Sections (11 sections, after scope and mode are agreed)

**Anti-skip rule:** Never condense, abbreviate, or skip any review section regardless of plan type. If a section genuinely has zero findings, say "No issues found" and move on, but you must evaluate it.

Ask the user about each issue ONE AT A TIME. Do NOT batch.

### Section 1: Architecture Review
Evaluate system design, component boundaries, data flow (all four paths), state machines, coupling, scaling, security architecture, production failure scenarios, rollback posture. Draw dependency graphs.

### Section 2: Error & Rescue Map
For every new method or codepath that can fail: name the exception, whether it's rescued, what the rescue action is, and what the user sees. Catch-all error handling is always a smell.

### Section 3: Security & Threat Model
Attack surface expansion, input validation, authorization, secrets management, dependency risk, data classification, injection vectors, audit logging.

### Section 4: Data Flow & Interaction Edge Cases
Trace every new data flow through input → validation → transform → persist → output, noting what happens at each node for nil, empty, wrong type, too long, timeout, conflict, encoding issues.

### Section 5: Code Quality Review
Organization, DRY violations, naming quality, error handling patterns, missing edge cases, over-engineering, under-engineering, cyclomatic complexity.

### Section 6: Test Review
Diagram every new UX flow, data flow, codepath, background job, integration, and error path. For each: what type of test covers it? Does one exist? What's the gap?

### Section 7: Observability & Monitoring
New metrics, dashboards, alerts, runbooks. For each new codepath: how would you know it's broken in production?

### Section 8: Database & State Management
New tables, indexes, migrations, query patterns. N+1 query risks. Data integrity constraints.

### Section 9: API Design & Contract
New endpoints, request/response shapes, backward compatibility, versioning, rate limiting.

### Section 10: Performance & Scalability
What breaks at 10x load? At 100x? Memory, CPU, network, database hotspots.

### Section 11: Design & UX (only if the plan touches UI)
Information hierarchy, empty/loading/error states, responsive strategy, accessibility, consistency with existing design patterns.

---

## Output

After all sections are reviewed, produce a clean summary:

**CEO REVIEW SUMMARY**
- **Mode:** [selected mode]
- **Strongest challenges:** [top 3 issues found]
- **Recommended path:** [what to do next]
- **Accepted scope:** [what's in]
- **Deferred:** [what's out and why]
- **NOT in scope:** [explicitly excluded items]

Save the summary to `memory/` for future reference.

---

## Important Rules

- **No code changes.** This skill reviews plans, it doesn't implement them.
- **One issue at a time.** Never batch multiple questions.
- **Every section gets evaluated.** "Doesn't apply" without examination is never valid.
- **The user is always in control.** Every scope change is an explicit opt-in.
- **Completion status:**
  - DONE ... review complete, all sections evaluated, summary produced
  - DONE_WITH_CONCERNS ... reviewed but with unresolved issues
  - BLOCKED ... cannot review without additional context
