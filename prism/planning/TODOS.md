# TODOS — Prism Triad MVP

## Post-Phase 1

### Verification calibration loop
**What:** After 3-5 real builds, review instrumentation logs (verification outcomes, override rates, false positive rates) and tune the LLM comparison prompt.
**Why:** First-version LLM self-evaluation prompts are notoriously noisy. Without calibration, users either learn to ignore warnings (defeating the purpose) or get frustrated by false alarms. The instrumentation data from Issue 9 tells you exactly where to adjust.
**Pros:** Targeted improvement with real data instead of guessing.
**Cons:** Requires 3-5 real sessions before it's actionable.
**Context:** The precedence hierarchy (tests > LLM advisory > user override) means false positives from the LLM layer are advisories, not blockers. But too many advisories train users to ignore them. The calibration pass adjusts the comparison prompt sensitivity based on observed false positive rates.
**Depends on:** Phase 1 implementation + at least 3 real builds with instrumentation logging.
**Added:** 2026-03-20 (eng review)

### Prompt precedence documentation
**What:** Define a precedence section in SKILL.md for when behavioral layers conflict (e.g., drift detection fires during verification, scope protection triggers during Socratic questioning).
**Why:** The skill has 6 existing guardrails + communication rules + stage behaviors. The triad adds Socratic depth, verification loops, and smart interrupts. Without explicit precedence, Claude makes inconsistent choices across sessions.
**Pros:** Consistent behavior across sessions. Debuggable when things go wrong.
**Cons:** Requires thinking through ~6 potential pairwise conflicts.
**Context:** Codex flagged this: "no one has defined prompt precedence when these behaviors conflict." Best done after Phase 1 when the actual behaviors exist and conflicts can be observed rather than predicted.
**Depends on:** Phase 1 implementation (need to observe actual conflicts before defining rules).
**Added:** 2026-03-20 (eng review)

## Included in Phase 1 (from eng review)

### Acceptance criteria self-check
**What:** During criteria generation, Claude validates each machine-layer assertion: "Could this actually fail? Is it specific enough to catch a real problem?"
**Why:** Addresses the critical gap where vague assertions cascade into weak tests. The two-layer criteria system is only as good as the machine-layer translation.
**Status:** Include in Phase 1 implementation (not deferred).
**Added:** 2026-03-20 (eng review)
