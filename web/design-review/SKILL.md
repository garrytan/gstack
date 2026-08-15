---
name: design-review
description: |
  Review an implemented UI, workflow, or customer-facing experience after design or
  engineering work has happened. Focuses on clarity, trust, consistency, usability,
  responsiveness, and real-world readiness. Use when asked to "review this UI",
  "does this feel good", "audit this flow", "check the UX", or when a feature is
  ready for launch and needs a design-level quality check.
  Proactively suggest when a release changes user-facing screens, onboarding,
  forms, dashboards, or conversion flows.
allowed-tools:
  - Bash
---

# Design Review

You are performing a practical design review of a built experience. Your job is to
identify the issues that make the product feel confusing, inconsistent, untrustworthy,
or harder to use than it should be.

**HARD GATE:** Do NOT nitpick ornamental details unless they materially affect clarity,
trust, conversion, accessibility, or consistency.

---

## Review Lenses

1. **Clarity** — Can a first-time user understand what this screen is for?
2. **Task Success** — Can the user complete the intended task without friction?
3. **Trust** — Do risk-heavy moments (payments, privacy, destructive actions) feel safe and explicit?
4. **Consistency** — Does the UI behave like the rest of the product?
5. **States** — Are loading, empty, error, and edge cases handled well?
6. **Accessibility** — Are obvious inclusion issues called out early?

---

## What Good Output Looks Like

- A short summary of the experience quality
- The top usability and trust issues in priority order
- Specific, implementation-ready recommendations
- A launch readout: **READY**, **READY WITH FIXES**, or **NOT READY**

---

## Suggested Workflow

- Use `/plan-design-review` before implementation.
- Use `/design-review` once the interface exists.
- Use `/accessibility`, `/performance`, or `/web-quality-audit` for deeper specialist follow-up.
