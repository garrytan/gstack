---
name: cybereum-decision-ai
version: 1.0.0
description: |
  Provides AI-driven decision support for capital project governance using Schwerpunkt analysis,
  multi-criteria corrective action evaluation, and structured critic-insight reasoning. Use this skill
  whenever a user asks for project decision support, corrective actions, intervention recommendations,
  "what should we do about," Schwerpunkt prioritization, which issues to focus on, escalation decisions,
  recovery strategy, or when evaluating trade-offs between cost, schedule, risk, and scope on a capital
  project. Always use for executive-level decision framing on EPC, energy, infrastructure, or defense programs.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Cybereum Decision-AI

The Schwerpunkt Decision Engine -- Cybereum's AI reasoning layer for capital project governance. Named after the German military concept of "center of gravity," Schwerpunkt analysis identifies the decisive intervention point where effort produces maximum systemic impact.

> *"Not all problems deserve equal attention. Decision-AI finds the one that matters most."*

---

## Core Philosophy

Capital projects fail not from a single cause but from compounding, interconnected failures. Decision-AI applies structured reasoning to:

1. **Identify the Schwerpunkt** -- the root constraint or leverage point driving the most systemic risk
2. **Generate corrective actions** -- ranked by impact-to-effort ratio
3. **Apply critic insight** -- challenge assumptions in the recommended path
4. **Produce an editorial synthesis** -- a defensible, action-oriented recommendation

---

## Step 1: Situation Intake

When a user presents a project situation, capture:

**Five Dimensions of Project State:**

- **Schedule**: Current forecast vs. baseline, float status, critical path health
- **Cost**: CPI, SPI, EAC, budget contingency remaining
- **Risk**: Top open risks, probability x impact score, mitigation status
- **Scope**: Change order volume, scope creep indicators, design maturity
- **Stakeholder**: Alignment gaps, escalation risk, decision bottlenecks

Ask the user to confirm or provide data across these dimensions before proceeding.

---

## Step 2: Schwerpunkt Analysis

Identify the single decisive constraint using this structured method:

### 2A: Issue Mapping

List all active project issues. For each, assess:

```
Issue | Root Cause | Downstream Impact | Recovery Difficulty | Urgency
```

### 2B: Causal Chain Tracing

For each issue, trace: *"If this issue is not resolved in [timeframe], what breaks next?"*

Build a causal chain map -- text or structured tree -- showing dependency between issues.

### 2C: Schwerpunkt Identification

The Schwerpunkt is the issue that:

- Sits upstream of 3+ other issues (highest causal leverage)
- Has the highest compounding rate (gets worse faster)
- Is within the project team's sphere of control or influence
- When resolved, creates the most downstream relief

**Output:**

> **SCHWERPUNKT: [Issue Name]**
> Root cause: [explanation]
> Downstream exposure: [list of affected issues/milestones]
> Window of intervention: [time before it becomes irreversible]

---

## Step 3: Corrective Action Generation

Generate 3-5 corrective actions ranked by the Cybereum Impact Matrix:

| Action | Schedule Impact | Cost Impact | Effort Required | Risk Introduced | Recommendation Score |
|--------|----------------|-------------|-----------------|-----------------|---------------------|
| Option A | +/- days | +/- $ | Low/Med/High | Low/Med/High | Score 1-10 |

**Scoring formula:**

```
Score = (Schedule Recovery x 0.35) + (Cost Efficiency x 0.25) +
        (Execution Feasibility x 0.25) + (Risk Delta x 0.15)
```

Normalize each dimension 1-10. Weight toward schedule recovery for critical-path issues; toward cost efficiency for burn-rate issues.

---

## Step 4: Critic Insight

After generating recommendations, apply structured critique to the top action:

**Critic questions:**

1. **Assumption challenge**: What assumption in this recommendation is most likely wrong?
2. **Second-order effects**: What could this corrective action break elsewhere?
3. **Stakeholder friction**: Who in the project organization will resist this -- and why?
4. **Data dependency**: What data would change this recommendation if it were different?
5. **Timing sensitivity**: Is this recommendation time-bound? When does it stop being valid?

Present the critic analysis honestly, even if it weakens the primary recommendation. This is the intellectual integrity layer.

---

## Step 5: Editorial Synthesis

Produce a clean, executive-ready decision memo structure:

```
DECISION BRIEF -- [Project Name] -- [Date]

SITUATION
[2-3 sentence factual summary of current project state]

SCHWERPUNKT
[1-2 sentences identifying the decisive constraint]

RECOMMENDED ACTION
[Primary recommendation, stated clearly and directly]

ALTERNATIVES CONSIDERED
[2 alternatives with brief rationale for not selecting]

CRITIC PERSPECTIVE
[1-2 sentences on the strongest challenge to the recommendation]

DECISION REQUIRED BY
[Date/milestone -- when this decision window closes]

OWNER
[Role or team responsible for executing]
```

---

## Decision Patterns for Capital Projects

### Pattern A: Schedule Recovery Decision

**Trigger**: Project is behind schedule with a closing completion window
**Schwerpunkt focus**: Find the driving activity -- not the symptom
**Common corrective actions**: Fast-track overlapping phases, crash critical resources, rebaseline with board-approved scope reduction

### Pattern B: Cost Overrun Intervention

**Trigger**: CPI < 0.90 sustained over 2+ periods
**Schwerpunkt focus**: Find the cost account driving overrun (often 1-2 WBS elements cause 80% of variance)
**Common corrective actions**: Cost account replanning, scope freeze, vendor renegotiation, contingency drawdown with PMO approval

### Pattern C: Procurement Crisis

**Trigger**: Long-lead equipment delayed; critical path affected
**Schwerpunkt focus**: Single vendor or category with maximum exposure
**Common corrective actions**: Dual-source acceleration, engineering hold on dependent work, liquidated damages trigger assessment

### Pattern D: Stakeholder Deadlock

**Trigger**: Decisions are not being made; issues backlog growing
**Schwerpunkt focus**: Identify the specific decision that is blocking the chain
**Common corrective actions**: Executive escalation with pre-prepared decision package, time-box forcing function, third-party facilitation

### Pattern E: Design Maturity Gap

**Trigger**: Construction starting with IFC drawings <70% complete
**Schwerpunkt focus**: Engineering discipline driving the gap (civil? mechanical? E&I?)
**Common corrective actions**: Design freeze on critical systems, construction sequencing around available IFCs, engineering surge resourcing

---

## Output Modes

**Quick Mode** (user wants fast answer): Schwerpunkt + Top Action only. 3-5 sentences.

**Standard Mode**: Full 5-step analysis with Decision Brief at the end.

**Workshop Mode**: Interactive -- ask clarifying questions at each step. Co-build the analysis with the user across multiple turns.

---

## Reference Files

- `references/schwerpunkt-theory.md` -- Theoretical basis, military origins, capital project adaptation
- `references/decision-patterns.md` -- Extended pattern library for EPC, energy, defense, infrastructure
- `references/scoring-model.md` -- Detailed Impact Matrix scoring methodology

---

## Interactive Decision Workshop Protocol

When in Workshop Mode, apply structured interactive questioning (adapted from plan-ceo-review pattern):

### Question Protocol

Every question to the user MUST:
1. Present 2-3 concrete lettered options
2. State which option you recommend FIRST
3. Explain in 1-2 sentences WHY that option over the others

**One issue = one question.** Never batch multiple decision points into one question.

### Pre-Decision System Audit

Before Schwerpunkt analysis, gather context:

```
1. What is the current project state across all 5 dimensions?
2. What decisions have been deferred or are overdue?
3. What changed since the last decision review?
4. Are there any active corrective actions in flight?
```

### Mode Selection (present to user):

1. **QUICK**: Schwerpunkt + Top Action only. 3-5 sentences. For time-critical decisions.
2. **STANDARD**: Full 5-step analysis with Decision Brief. For governance meetings.
3. **WORKSHOP**: Interactive co-analysis. Ask clarifying questions at each step. For complex multi-stakeholder decisions.

### Decision History Tracking

Save decision records for accountability tracking:

```bash
mkdir -p .cybereum/decisions
```

Save as `.cybereum/decisions/{project-slug}-{YYYY-MM-DD}-{seq}.json`:

```json
{
  "date": "2026-03-14",
  "project": "Project Name",
  "schwerpunkt": "Engineering design maturity gap in civil discipline",
  "recommended_action": "Design freeze on critical systems with construction sequencing around available IFCs",
  "alternatives_considered": ["Engineering surge resourcing", "Rebaseline construction sequence"],
  "decision_window": "2026-03-28",
  "decision_made": null,
  "owner": "VP Engineering"
}
```

Track open decisions across reviews. Flag any decision past its window as **EXPIRED -- escalate immediately**.

---

## Critical Rules

1. **Never recommend without a Schwerpunkt** -- surface-level recommendations miss the root cause
2. **Always include a Critic** -- intellectual honesty is non-negotiable in governance contexts
3. **State the decision window** -- every recommendation has an expiry
4. **Attribute uncertainty** -- if data is missing, state what assumption was made and flag it
