<!-- AUTO-GENERATED from greptile.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 10: Address Greptile review comments (if PR exists)

**Dispatch the fetch + classification as a subagent** using the Agent tool with `subagent_type: "general-purpose"`. The subagent pulls every Greptile comment, runs the escalation detection algorithm, and classifies each comment. Parent receives a structured list and handles user interaction + file edits.

**Foreground required:** pass `run_in_background: false` on the Agent call — subagents run in the BACKGROUND by default since Claude Code v2.1.198. (Merely omitting the flag no longer produces a foreground run; it must be explicitly false.) The dispatch happens ONLY via the Agent tool: invoking the target as a Skill, or executing its workflow inline in your own context, is WRONG even though the skill may appear in your available-skills list — inline execution forfeits the fresh-context isolation this dispatch exists for, and the explicit flag already makes the Agent call block. (Where a step defines an inline FALLBACK, it applies only after a dispatched subagent has failed.)

**Subagent prompt:**

> You are classifying Greptile review comments for a /ship workflow. Read `~/.claude/skills/gstack/review/greptile-triage.md` and follow the fetch, filter, classify, and **escalation detection** steps. Do NOT fix code, do NOT reply to comments, do NOT commit — report only.
>
> For each comment, assign: `classification` (`valid_actionable`, `already_fixed`, `false_positive`, `suppressed`), `escalation_tier` (1 or 2), the file:line or [top-level] tag, body summary, and permalink URL.
>
> If no PR exists, `gh` fails, the API errors, or there are zero comments, output: `{"total":0,"comments":[]}` and stop.
>
> Otherwise, output a single JSON object on the LAST LINE of your response:
> `{"total":N,"comments":[{"classification":"...","escalation_tier":N,"ref":"file:line","summary":"...","permalink":"url"},...]}`

**Parent processing:**

Parse the LAST line as JSON.

If `total` is 0, skip this step silently. Continue to Step 12.

**If the subagent fails, returns invalid JSON, or never completes (backgrounded despite the flag, or no final output after ~10 minutes — stop waiting; if a backgrounded task is still running, stop it first so a late result never lands mid-ship):** print `Greptile triage did not complete — review the PR comments manually` and continue to Step 12, recording the triage as UNAVAILABLE — not as zero comments — in the PR body: add the literal line `Greptile triage: UNAVAILABLE (dispatch failed)` to the review-results section Step 19 assembles (an unavailable triage must not read as a clean one; Step 20's metrics schema carries no triage field, so the PR body is the record). Do not block /ship on the triage subagent.

Otherwise, print: `+ {total} Greptile comments ({valid_actionable} valid, {already_fixed} already fixed, {false_positive} FP)`.

For each comment in `comments`:

**VALID & ACTIONABLE:** Use AskUserQuestion with:
- The comment (file:line or [top-level] + body summary + permalink URL)
- `RECOMMENDATION: Choose A because [one-line reason]`
- Options: A) Fix now, B) Acknowledge and ship anyway, C) It's a false positive
- If user chooses A: apply the fix, commit the fixed files (`git add <fixed-files> && git commit -m "fix: address Greptile review — <brief description>"`), reply using the **Fix reply template** from greptile-triage.md (include inline diff + explanation), and save to both per-project and global greptile-history (type: fix).
- If user chooses C: reply using the **False Positive reply template** from greptile-triage.md (include evidence + suggested re-rank), save to both per-project and global greptile-history (type: fp).

**VALID BUT ALREADY FIXED:** Reply using the **Already Fixed reply template** from greptile-triage.md — no AskUserQuestion needed:
- Include what was done and the fixing commit SHA
- Save to both per-project and global greptile-history (type: already-fixed)

**FALSE POSITIVE:** Use AskUserQuestion:
- Show the comment and why you think it's wrong (file:line or [top-level] + body summary + permalink URL)
- Options:
  - A) Reply to Greptile explaining the false positive (recommended if clearly wrong)
  - B) Fix it anyway (if trivial)
  - C) Ignore silently
- If user chooses A: reply using the **False Positive reply template** from greptile-triage.md (include evidence + suggested re-rank), save to both per-project and global greptile-history (type: fp)

**SUPPRESSED:** Skip silently — these are known false positives from previous triage.

**After all comments are resolved:** If any fixes were applied, the tests from Step 5 are now stale. **Re-run tests** (Step 5) before continuing to Step 12. If no fixes were applied, continue to Step 12.

---
