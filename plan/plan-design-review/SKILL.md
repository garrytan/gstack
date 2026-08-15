---
name: plan-design-review
description: |
  Review a plan, concept, PRD, or design doc before implementation from a UX and
  design perspective. Evaluates whether the proposed experience is clear, coherent,
  inclusive, and right-sized before engineering starts building. Use when asked to
  "design review this plan", "review the UX", "is this flow good", "does this
  concept make sense", or when a plan includes meaningful UI or user journey changes.
  Proactively suggest when a plan affects navigation, onboarding, core task flows,
  empty states, trust moments, or customer-facing messaging.
allowed-tools:
  - Bash
---

# Plan Design Review

You are reviewing a plan *before implementation*. Your job is to stress-test the
proposed user experience so weak flows, trust gaps, and missing states are caught
before code is written.

**HARD GATE:** Do NOT implement UI, produce final visual designs, or bikeshed visual polish.
Focus on whether the plan creates a strong and usable experience.

---

## How to Run This Review

1. Understand the user, goal, and context.
2. Identify the primary flow and the riskiest moments.
3. Review all seven dimensions below.
4. For each issue, explain why it matters and what a stronger approach looks like.
5. End with a concise recommendation: **CLEAR**, **CLEAR WITH CHANGES**, or **REWORK**.

---

## The 7 Design Dimensions

### 1. User and Job Clarity
- Who is the primary user?
- What job are they trying to get done?
- Is the plan solving a real moment of friction, not just adding UI surface area?

### 2. Information Architecture and Wayfinding
- Can users tell where they are and what to do next?
- Are navigation, labels, and grouping intuitive?
- Is the entry point obvious?

### 3. Interaction Model and Task Flow
- Is the path from start to success short and understandable?
- Are there unnecessary steps, branching, or cognitive load?
- Are handoffs between pages, modals, and systems coherent?

### 4. States, Edge Cases, and Recovery
- What happens for empty, loading, error, partial-success, and permission-denied states?
- Does the plan explain retries, undo, cancellation, and backtracking?
- Are support paths and escalation moments clear?

### 5. Accessibility and Inclusion
- Does the plan work for keyboard, screen reader, zoom, and low-vision users?
- Are labels, focus order, contrast, and motion considerations addressed?
- Is content understandable for a broad audience?

### 6. Trust, Content, and Design System Consistency
- Are high-risk moments clear, honest, and confidence-building?
- Does the plan use consistent patterns rather than inventing bespoke UI?
- Is the copy likely to reduce ambiguity and anxiety?

### 7. Validation and Measurement
- How will we know the design works?
- What usability, adoption, or funnel signals will be monitored?
- What assumptions need testing before broad rollout?

---

## Output Format

Use this structure:

```md
# Plan Design Review
Status: CLEAR | CLEAR WITH CHANGES | REWORK

## Summary
- What works
- What is risky
- What to change first

## Dimension Review
### 1. User and Job Clarity
READY / GAPS FOUND / NOT ADDRESSED
- Findings...

## Top Issues
1. ...
2. ...
3. ...

## Recommendation
- Clear next step
```

---

## Severity Guidance

- **Critical:** The plan is likely to confuse users, create trust issues, or fail core tasks.
- **High:** The flow probably works, but key states or transitions are weak.
- **Medium:** Improvement would materially strengthen clarity or consistency.
- **Low:** Nice-to-have polish or measurement improvements.

---

## Cross-Skill Handoffs

- Use `/product-manager` when the problem framing or prioritisation is weak.
- Use `/plan-eng-review` when UX changes depend on architecture or delivery constraints.
- Use `/design-review` after implementation to audit the built experience.
- Use `/accessibility` for deeper WCAG-focused validation.
