---
name: review
version: 1.0.0
description: |
  Pre-landing PR review for Cybereum. Analyzes diff against main for calculation
  integrity, graph consistency, cross-skill coherence, LLM trust boundary
  violations, and structural issues in capital project analytics code.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
---

# Pre-Landing PR Review

You are running the `/review` workflow for Cybereum. Analyze the current branch's diff against main for structural issues that tests don't catch -- with special attention to calculation correctness, data consistency, and cross-skill coherence.

---

## Step 1: Check branch

1. Run `git branch --show-current` to get the current branch.
2. If on `main`, output: **"Nothing to review -- you're on main or have no changes against main."** and stop.
3. Run `git fetch origin main --quiet && git diff origin/main --stat` to check if there's a diff. If no diff, output the same message and stop.

---

## Step 2: Read the checklist

Read `review/checklist.md` (or `.claude/skills/review/checklist.md`).

**If the file cannot be read, STOP and report the error.** Do not proceed without the checklist.

---

## Step 3: Get the diff

Fetch the latest main to avoid false positives from a stale local main:

```bash
git fetch origin main --quiet
```

Run `git diff origin/main` to get the full diff. This includes both committed and uncommitted changes against the latest main.

---

## Step 4: Two-pass review

Apply the checklist against the diff in two passes:

1. **Pass 1 (CRITICAL):** Data & Calculation Integrity, Graph & Data Consistency, LLM Output Trust Boundary
2. **Pass 2 (INFORMATIONAL):** Skill Content Quality, Cross-Skill Consistency, Conditional Side Effects, Dead Code, LLM Prompt Issues, Test Gaps, Type Coercion, File Parsing Safety

Follow the output format specified in the checklist. Respect the suppressions -- do NOT flag items listed in the "DO NOT flag" section.

---

## Step 5: Output findings

**Always output ALL findings** -- both critical and informational. The user must see every issue.

- If CRITICAL issues found: output all findings, then for EACH critical issue use a separate AskUserQuestion with the problem, your recommended fix, and options (A: Fix it now, B: Acknowledge, C: False positive -- skip).
  After all critical questions are answered, output a summary of what the user chose for each issue. If the user chose A (fix) on any issue, apply the recommended fixes. If only B/C were chosen, no action needed.
- If only non-critical issues found: output findings. No further action needed.
- If no issues found: output `Pre-Landing Review: No issues found.`

---

## Important Rules

- **Read the FULL diff before commenting.** Do not flag issues already addressed in the diff.
- **Read-only by default.** Only modify files if the user explicitly chooses "Fix it now" on a critical issue. Never commit, push, or create PRs.
- **Be terse.** One line problem, one line fix. No preamble.
- **Only flag real problems.** Skip anything that's fine.
- **Cross-check formulas.** When reviewing EVM, risk, or schedule skills, verify calculations match their stated methodology.
