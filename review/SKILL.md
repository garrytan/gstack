---
name: review
version: 1.0.0
description: |
  Pre-landing PR review. Analyzes diff against main for SQL safety, LLM trust
  boundary violations, conditional side effects, and other structural issues.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Update Check (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (AskUserQuestion → upgrade if yes, `touch ~/.gstack/last-update-check` if no). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

# Pre-Landing PR Review

You are running the `/review` workflow. Analyze the current branch's diff against main for structural issues that tests don't catch.

---

## Step 1: Check branch

1. Run `git branch --show-current` to get the current branch.
2. If on `main`, output: **"Nothing to review — you're on main or have no changes against main."** and stop.
3. Run `git fetch origin main --quiet && git diff origin/main --stat` to check if there's a diff. If no diff, output the same message and stop.

---

## Step 2: Read the checklist

Read `.claude/skills/review/checklist.md`.

**If the file cannot be read, STOP and report the error.** Do not proceed without the checklist.

---

## Step 2.5: Check for Greptile review comments

Read `.claude/skills/review/greptile-triage.md` and follow the fetch, filter, and classify steps.

**If no PR exists, `gh` fails, API returns an error, or there are zero Greptile comments:** Skip this step silently. Greptile integration is additive — the review works without it.

**If Greptile comments are found:** Store the classifications (VALID & ACTIONABLE, VALID BUT ALREADY FIXED, FALSE POSITIVE, SUPPRESSED) — you will need them in Step 5.

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

1. **Pass 1 (CRITICAL):** SQL & Data Safety, LLM Output Trust Boundary
2. **Pass 2 (INFORMATIONAL):** Conditional Side Effects, Magic Numbers & String Coupling, Dead Code & Consistency, LLM Prompt Issues, Test Gaps, View/Frontend

Follow the output format specified in the checklist. Respect the suppressions — do NOT flag items listed in the "DO NOT flag" section.

---

## Step 5: Output findings

**Always output ALL findings** — both critical and informational. The user must see every issue.

- If CRITICAL issues found: output all findings, then for EACH critical issue use a separate AskUserQuestion with the problem, your recommended fix, and options (A: Fix it now, B: Acknowledge, C: False positive — skip).
  After all critical questions are answered, output a summary of what the user chose for each issue. If the user chose A (fix) on any issue, apply the recommended fixes. If only B/C were chosen, no action needed.
- If only non-critical issues found: output findings. No further action needed.
- If no issues found: output `Pre-Landing Review: No issues found.`

### Greptile comment resolution

After outputting your own findings, if Greptile comments were classified in Step 2.5:

**Include a Greptile summary in your output header:** `+ N Greptile comments (X valid, Y fixed, Z FP)`

1. **VALID & ACTIONABLE comments:** These are already included in your CRITICAL findings — they follow the same AskUserQuestion flow (A: Fix it now, B: Acknowledge, C: False positive). If the user chooses C (false positive), post a reply using the appropriate API from the triage doc and save the pattern to both per-project and global greptile-history (see greptile-triage.md for write details).

2. **FALSE POSITIVE comments:** Present each one via AskUserQuestion:
   - Show the Greptile comment: file:line (or [top-level]) + body summary + permalink URL
   - Explain concisely why it's a false positive
   - Options:
     - A) Reply to Greptile explaining why this is incorrect (recommended if clearly wrong)
     - B) Fix it anyway (if low-effort and harmless)
     - C) Ignore — don't reply, don't fix

   If the user chooses A, post a reply using the appropriate API from the triage doc and save the pattern to both per-project and global greptile-history (see greptile-triage.md for write details).

3. **VALID BUT ALREADY FIXED comments:** Reply acknowledging the catch — no AskUserQuestion needed:
   - Post reply: `"Good catch — already fixed in <commit-sha>."`
   - Save to both per-project and global greptile-history (see greptile-triage.md for write details)

4. **SUPPRESSED comments:** Skip silently — these are known false positives from previous triage.

---

## Step 6: Save Review Artifacts

After findings are output and any critical issues resolved, save the review for future sessions.

```bash
mkdir -p .gstack/reviews
SEQ=$(ls .gstack/reviews/review-$(date +%Y-%m-%d)-*.json 2>/dev/null | wc -l | tr -d ' ')
SEQ=$((SEQ + 1))
DATE=$(date +%Y-%m-%d)
```

Write the full review to `.gstack/reviews/review-{DATE}-{SEQ}.md` containing:
- Branch name and commit range reviewed
- All findings (critical and informational) with file:line references
- Greptile summary and comment resolutions (if applicable)
- Resolution status for each critical issue (fixed / acknowledged / false positive)

Write structured JSON to `.gstack/reviews/review-{DATE}-{SEQ}.json`:
```json
{
  "skill": "review",
  "date": "{DATE}",
  "seq": {SEQ},
  "branch": "...",
  "critical_count": 0,
  "informational_count": 0,
  "findings": [...],
  "greptile_summary": "...",
  "resolutions": [...]
}
```

Regenerate `.gstack/HANDOFF.md` by reading the most recent archive of each type from `.gstack/reviews/` (most recent `plan-ceo-*.json`, `plan-eng-*.json`, `review-*.json`) and combining them:

```markdown
# Handoff — {DATE}

Generated by gstack. Read this before starting implementation.

## CEO Review ({date from most recent plan-ceo archive})
<completion summary, error/rescue registry, failure modes, scope exclusions, key diagrams>

## Eng Review ({date from most recent plan-eng archive})
<completion summary, architecture analysis, test matrix, implementation plan>

## Code Review ({date from most recent review archive})
<findings list, summary stats>

## Open Items
<aggregated TODOs and unresolved decisions from all reviews, deduplicated>
```

Only include sections for which archives exist. Omit sections with no prior reviews of that type.

Output: `Review saved to .gstack/reviews/ and handoff regenerated at .gstack/HANDOFF.md.`

---

## Important Rules

- **Read the FULL diff before commenting.** Do not flag issues already addressed in the diff.
- **Read-only by default.** Only modify files if the user explicitly chooses "Fix it now" on a critical issue. Never commit, push, or create PRs.
- **Be terse.** One line problem, one line fix. No preamble.
- **Only flag real problems.** Skip anything that's fine.
