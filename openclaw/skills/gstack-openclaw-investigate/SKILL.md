---
name: gstack-openclaw-investigate
description: Systematic debugging with root cause investigation. Four phases: investigate, analyze, hypothesize, implement. Iron Law: no fixes without root cause. Use when asked to debug, fix a bug, investigate an error, or root cause analysis. Proactively use when user reports errors, stack traces, unexpected behavior, or says something stopped working.
version: 1.0.0
metadata: { "openclaw": { "emoji": "🔍" } }
---

# Systematic Debugging

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Fixing symptoms creates whack-a-mole debugging. Every fix that doesn't address root cause makes the next bug harder to find. Find the root cause, then fix it.

---

## Phase 1: Root Cause Investigation

Gather context before forming any hypothesis.

1. **Collect symptoms:** Read the error messages, stack traces, and reproduction steps. If the user hasn't provided enough context, ask ONE question at a time. Don't ask five questions at once.

2. **Read the code:** Trace the code path from the symptom back to potential causes. Search for all references, read the logic around the failure point.

3. **Check recent changes:**
   ```bash
   git log --oneline -20 -- <affected-files>
   ```
   Was this working before? What changed? A regression means the root cause is in the diff.

4. **Reproduce:** Can you trigger the bug deterministically? If not, gather more evidence before proceeding.

5. **Check memory** for prior debugging sessions on the same area. Recurring bugs in the same files are an architectural smell.

Output: **"Root cause hypothesis: ..."** ... a specific, testable claim about what is wrong and why.

---

## Phase 2: Pattern Analysis

Check if this bug matches a known pattern:

**Race condition** ... Intermittent, timing-dependent. Look at concurrent access to shared state.

**Nil/null propagation** ... NoMethodError, TypeError. Missing guards on optional values.

**State corruption** ... Inconsistent data, partial updates. Check transactions, callbacks, hooks.

**Integration failure** ... Timeout, unexpected response. External API calls, service boundaries.

**Configuration drift** ... Works locally, fails in staging/prod. Env vars, feature flags, DB state.

**Stale cache** ... Shows old data, fixes on cache clear. Redis, CDN, browser cache.

Also check:
- Known issues in the project for related problems
- Git log for prior fixes in the same area. Recurring bugs in the same files are an architectural smell, not a coincidence.

**External search:** If the bug doesn't match a known pattern, search for the error type online. **Sanitize first:** strip hostnames, IPs, file paths, SQL, customer data. Search the error category, not the raw message.

---

## Phase 3: Hypothesis Testing

Before writing ANY fix, verify your hypothesis.

1. **Confirm the hypothesis:** Add a temporary log statement, assertion, or debug output at the suspected root cause. Run the reproduction. Does the evidence match?

2. **If the hypothesis is wrong:** Search for the error (sanitize sensitive data first). Return to Phase 1. Gather more evidence. Do not guess.

3. **3-strike rule:** If 3 hypotheses fail, **STOP**. Tell the user:

   "3 hypotheses tested, none match. This may be an architectural issue rather than a simple bug."

   Options:
   - Continue investigating with a new hypothesis (describe it)
   - Escalate for human review (needs someone who knows the system)
   - Add logging and wait (instrument the area and catch it next time)

**Red flags** ... if you see any of these, slow down:
- "Quick fix for now" ... there is no "for now." Fix it right or escalate.
- Proposing a fix before tracing data flow ... you're guessing.
- Each fix reveals a new problem elsewhere ... wrong layer, not wrong code.

---

## Phase 4: Implementation

Once root cause is confirmed:

1. **Fix the root cause, not the symptom.** The smallest change that eliminates the actual problem.

2. **Minimal diff:** Fewest files touched, fewest lines changed. Resist the urge to refactor adjacent code.

3. **Write a regression test** that:
   - **Fails** without the fix (proves the test is meaningful)
   - **Passes** with the fix (proves the fix works)

4. **Run the full test suite.** No regressions allowed.

5. **If the fix touches >5 files:** Flag the blast radius to the user before proceeding. That's large for a bug fix.

---

## Phase 5: Verification & Report

**Fresh verification:** Reproduce the original bug scenario and confirm it's fixed. This is not optional.

Run the test suite.

Output a structured debug report:

**DEBUG REPORT**
- **Symptom:** what the user observed
- **Root cause:** what was actually wrong
- **Fix:** what was changed, with file references
- **Evidence:** test output, reproduction showing fix works
- **Regression test:** location of the new test
- **Related:** prior bugs in same area, architectural notes
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED

Save the report to `memory/` with today's date so future sessions can reference it.

---

## Important Rules

- **3+ failed fix attempts: STOP and question the architecture.** Wrong architecture, not failed hypothesis.
- **Never apply a fix you cannot verify.** If you can't reproduce and confirm, don't ship it.
- **Never say "this should fix it."** Verify and prove it. Run the tests.
- **If fix touches >5 files:** Flag to user before proceeding.
- **Completion status:**
  - DONE ... root cause found, fix applied, regression test written, all tests pass
  - DONE_WITH_CONCERNS ... fixed but cannot fully verify (e.g., intermittent bug, requires staging)
  - BLOCKED ... root cause unclear after investigation, escalated
