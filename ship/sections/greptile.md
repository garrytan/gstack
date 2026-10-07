<!-- AUTO-GENERATED from greptile.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 10: Address Greptile review comments (if PR exists)

Check for a PR first. Greptile reviews a PR, so with no PR, no `gh`, no `gh` login or
a non-GitHub remote there is nothing to triage yet:

```bash
if ! command -v gh >/dev/null 2>&1; then echo "PR: skip (gh not installed)"
elif ! gh auth status >/dev/null 2>&1; then echo "PR: skip (gh not logged in)"
elif ! _GH_ERR=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>&1 >/dev/null); then echo "PR: skip (not a GitHub remote: $(printf '%s' "$_GH_ERR" | head -1))"
elif _PR_ERR=$(gh pr view --json number -q .number 2>&1 >/dev/null); then echo "PR: exists"
else case "$_PR_ERR" in *"no pull requests found"*) echo "PR: skip (no PR yet)" ;; *) echo "PR: skip (PR lookup failed: $(printf '%s' "$_PR_ERR" | head -1))" ;; esac
fi
```

Only `PR: exists` dispatches. `PR: skip (<reason>)` → do not dispatch; record
"Greptile: not run (<reason>); runs on the PR once it exists" and continue to Step 11.

**Early PR (Step 6.5):** when the record holds `EARLY_PR` and `EARLY_PR_OPENED_AT`, first
wait for Greptile's review of that PR, substituting both values:

```bash
~/.claude/skills/gstack/bin/gstack-greptile-early wait <pr-number> --since <opened-at>
```

Each call returns within about 90 seconds; relay its progress line. Rerun on
`GREPTILE_REVIEW: pending`. `complete` dispatches below. `timeout` or `unavailable` takes
the Unavailable triage route with that line as the reason, never a claim of zero
comments. Comments on the early head are triaged against the current diff
(`already_fixed` when the code has moved on).

Dispatch a subagent through Agent with `subagent_type: "general-purpose"` and
`run_in_background: false`, using Step 7's shared foreground-dispatch rule.
It fetches and classifies all Greptile comments,
including escalation tiers; the parent handles decisions and queues approved fixes.

**Subagent prompt:**

> You are classifying Greptile review comments for a /ship workflow. Read `~/.claude/skills/gstack/review/greptile-triage.md` and follow the fetch, filter, classify, and **escalation detection** steps. Do NOT fix code, do NOT reply to comments, do NOT commit — report only.
>
> For each comment, assign: `classification` (`valid_actionable`, `already_fixed`, `false_positive`, `suppressed`), `escalation_tier` (1 or 2), the file:line or [top-level] tag, body summary, and permalink URL.
>
> Return one JSON object on the LAST LINE:
> `{"status":"complete|no_pr|unavailable","total":N,"comments":[{"classification":"...","escalation_tier":N,"ref":"file:line","summary":"...","permalink":"url"},...],"reason":"..."}`
> Use `complete` only after a successful fetch, including zero comments; `no_pr` only after confirming no PR exists; `unavailable` for `gh`/API errors or incomplete classification. The latter two return zero total and an empty array. State the failure reason for `unavailable`; otherwise use an empty reason.

**Parent processing:**

Parse the LAST line as JSON. Require the declared status, a nonnegative integer
total matching the comments array, and the status/reason invariants above. An
unknown or missing status is unavailable, never an empty successful review.

For `no_pr`, record "Greptile: no PR exists"; for `complete` with zero comments,
record "Greptile: fetched, zero comments". Both continue to Step 11.

**Unavailable triage:** A returned `unavailable`, failed dispatch, invalid result,
or missing completion after ~10 minutes takes this route. Stop a running child
and confirm it stopped before continuing. Print `Greptile triage did not complete — review the PR comments manually`.
Include `Greptile triage: UNAVAILABLE (dispatch failed)` and the actual reason in
Step 19's review results; Step 20 has no triage field. Continue to Step 11 without
claiming zero comments or completed triage. This optional triage does not block ship.

Otherwise, print: `+ {total} Greptile comments ({valid_actionable} valid, {already_fixed} already fixed, {false_positive} FP)`.

For each comment in `comments`:

**VALID & ACTIONABLE:** Use AskUserQuestion with:
- The comment (file:line or [top-level] + body summary + permalink URL)
- `RECOMMENDATION: Choose A because [one-line reason]`
- Options: A) Fix now, B) Acknowledge and ship anyway, C) It's a false positive
- If user chooses A: queue the approved fix without editing here. After that fix passes review and tests, use the **Fix reply template** from greptile-triage.md (inline diff + explanation) and save per-project/global greptile-history (type: fix).
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
- If user chooses B: queue the approved fix, as above.

**SUPPRESSED:** Skip silently — these are known false positives from previous triage.

**After triage:** If fixes were approved, save their approvals and comment references.
Run Step 9's full review/fix loop, then return here. Finish the saved replies
without asking again about completed fixes, and classify new comments.
With no queued fixes, continue to Step 11.

---
