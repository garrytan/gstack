<!-- AUTO-GENERATED from pr-body.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 18: Documentation handoff

Documentation synchronization already completed in Step 11.5 before the
release transaction. Do not dispatch a helper or edit documentation here.
Reuse the retained `documentation_section`; omit the section if it is null.

---

## Step 19: Create PR/MR

**Idempotency check:** Discover an existing PR/MR through the closed adapter.
Use the GitHub/GitLab platform already detected in Step 0; never invoke an
ambient provider CLI for this decision.

```bash
# Set to github or gitlab from the canonical platform detection in Step 0.
: "${PROVIDER_KIND:?provider platform must be detected before PR/MR discovery}"
PR_LOOKUP_JSON=$($GSTACK_ANCHOR_INVOCATION gstack-effect-scope provider-pr \
  discover --skill ship --provider "$PROVIDER_KIND" --json) || exit 1
PR_LOOKUP_PROVIDER=$(printf '%s' "$PR_LOOKUP_JSON" | jq -er '.result.provider | select(. == "github" or . == "gitlab")') || exit 1
PR_LOOKUP_STATUS=$(printf '%s' "$PR_LOOKUP_JSON" | jq -er '.result.status | select(. == "present" or . == "absent")') || exit 1
[ "$PR_LOOKUP_PROVIDER" = "$PROVIDER_KIND" ] || { echo "BLOCKED — provider discovery mismatch"; exit 1; }
if [ "$PR_LOOKUP_STATUS" = "present" ]; then
  PR_EXISTS=1
  PR_NUMBER=$(printf '%s' "$PR_LOOKUP_JSON" | jq -er '.result.number | select(type == "number" and . > 0)') || exit 1
  PR_URL=$(printf '%s' "$PR_LOOKUP_JSON" | jq -er '.result.url | select(type == "string" and length > 0)') || exit 1
  PR_CURRENT_TITLE=$(printf '%s' "$PR_LOOKUP_JSON" | jq -er '.result.title | select(type == "string" and length > 0)') || exit 1
  printf '%s #%s: %s\n' "$PROVIDER_KIND" "$PR_NUMBER" "$PR_URL"
else
  PR_EXISTS=0
fi
```

If an **open** PR/MR already exists, retain its exact identity and current title
for the shared composition, scan, and publication block below. Do not publish
or advance to another step yet.
The closed adapter verifies the provider against the canonical remote and binds
the update grant and CLI call to this exact PR/MR number. Never reuse stale PR
body content from a prior run.

Provider fallbacks remain internal to that adapter and reuse the exact scanned
bytes. The workflow must not issue raw provider update requests.
The create path repeats the same attested branch-bound absence check immediately
before consuming its grant, so stale or spoofed discovery cannot create a duplicate.

**Always apply `RELEASE_TITLE_POLICY`.** The title policy is the same trusted
decision used by allocation, metadata writing, and the ShipReceipt. It is not a
caller-selected formatting preference.

1. If `PR_EXISTS=1`, read the current provider title. Otherwise compose a
   non-empty `PR_TITLE_CANDIDATE` from the complete substantive change summary
   and set `CURRENT=$PR_TITLE_CANDIDATE`. For `conventional`, the candidate must
   already use `type(scope): description`; for `free`, use the clearest concise
   description. Never issue a raw provider lookup in the new-PR branch.
   ```bash
   if [ "$PR_EXISTS" = "1" ]; then
     CURRENT=$PR_CURRENT_TITLE
   else
     : "${PR_TITLE_CANDIDATE:?compose a non-empty title from the substantive change summary}"
     CURRENT=$PR_TITLE_CANDIDATE
   fi
   ```
2. Compute the corrected title through the anchored strict frontend:
   ```bash
   TITLE_VERSION_ARGS=()
   [ "$RELEASE_APPLICABLE" = "true" ] && [ "$RELEASE_TITLE_POLICY" = "version_prefix" ] && TITLE_VERSION_ARGS=(--version "$NEW_VERSION")
   NEW_TITLE=$($GSTACK_ANCHOR_INVOCATION gstack-pr-title-rewrite \
     --lane "$ECPE_EXECUTION_LANE" --assert-target-ref origin/<base> --assert-title-policy "$RELEASE_TITLE_POLICY" \
     "${RELEASE_REQUEST_ARGS[@]}" "${TITLE_VERSION_ARGS[@]}" --title "$CURRENT") || exit 1
   PROVIDER_TITLE_ASSERTIONS=(--lane "$ECPE_EXECUTION_LANE" --assert-target-ref origin/<base> \
     --assert-release-mode "$RELEASE_MODE" --assert-title-policy "$RELEASE_TITLE_POLICY" \
     "${RELEASE_REQUEST_ARGS[@]}" "${TITLE_VERSION_ARGS[@]}")
   ```
3. If `NEW_TITLE` differs from `CURRENT`, pass it to the same closed
   `provider-pr update` invocation.
4. **Self-check:** the closed adapter performs an exact numbered provider read
   after the mutation and requires the live title, number, open state, repository
   URL, and provider to match. It fails before returning otherwise. Do not infer
   a version-prefix invariant for conventional or free titles.

This keeps the title truthful when Step 12's queue-drift detection rebumps a stale version, and forces the format on PRs that were created without it.

If no PR/MR exists, use the same shared block below to create it with the
platform detected in Step 0.

For either path, compose fresh results below and never reuse a prior run's body.
The PR/MR body should contain these sections:

```
## Summary
<Summarize ALL changes being shipped. Run `git log <base>..HEAD --oneline` to enumerate
every commit. Exclude the VERSION/CHANGELOG metadata commit (that's this PR's bookkeeping,
not a substantive change). Group the remaining commits into logical sections (e.g.,
"**Performance**", "**Dead Code Removal**", "**Infrastructure**"). Every substantive commit
must appear in at least one section. If a commit's work isn't reflected in the summary,
you missed it.>

## Test Coverage
<coverage diagram from Step 7, or "All new code paths have test coverage.">
<If Step 7 ran: "Tests: {before} → {after} (+{delta} new)">

## Pre-Landing Review
<findings from Step 9 code review, or "No issues found.">

## Design Review
<If design review ran: "Design Review (lite): N findings — M auto-fixed, K skipped. AI Slop: clean/N issues.">
<Detector: "clean" | "N findings (rule-id, rule-id)" | "not installed" | "not cached" | "off" — the state the probe printed; rule ids and counts only, finding text and snippets never reach the PR body.>
<If no frontend files changed: "No frontend files changed — design review skipped.">

## Eval Results
<If evals ran: suite names, pass/fail counts, cost dashboard summary. If skipped: "No prompt-related files changed — evals skipped.">

## Greptile Review
<If Greptile comments were found: bullet list with [FIXED] / [FALSE POSITIVE] / [ALREADY FIXED] tag + one-line summary per comment>
<If no Greptile comments found: "No Greptile comments.">
<If no PR existed during Step 10: omit this section entirely>

## Scope Drift
<If scope drift ran: "Scope Check: CLEAN" or list of drift/creep findings>
<If no scope drift: omit this section>

## Plan Completion
<If plan file found: completion checklist summary from Step 8>
<If no plan file: "No plan file detected.">
<If plan items deferred: list deferred items>

## Linked Spec
<Auto-detect: look for /spec archives matching this branch via:
  eval "$(~/.claude/skills/gstack/bin/gstack-paths)"
  eval "$(~/.claude/skills/gstack/bin/gstack-slug)"
  CURRENT_BRANCH=$(git branch --show-current)
  SPEC_ARCHIVES="$GSTACK_STATE_ROOT/projects/$SLUG/specs"
  # Find newest archive whose spec_branch frontmatter matches current branch (or one of its
  # parents — if spec spawned worktree spec/<slug>-$$, the spawned worktree IS where /ship runs).
  SPEC_FILE=$(grep -l "^spec_branch: $CURRENT_BRANCH$" "$SPEC_ARCHIVES"/*.md 2>/dev/null | head -1)
  [ -z "$SPEC_FILE" ] && exit  # no spec; omit this section entirely
  SPEC_ISSUE=$(grep "^spec_issue_number:" "$SPEC_FILE" | cut -d' ' -f2)
  [ -z "$SPEC_ISSUE" ] && exit  # spec archive exists but no issue number; omit

  # CONDITIONAL Closes #N (codex F4): only add when Plan Completion above is "complete".
  # If the plan completion gate from Step 8 reports any deferred or failed items, emit:
  #   "Linked to #$SPEC_ISSUE (partial delivery — NOT auto-closing; close manually after follow-up)"
  # If Plan Completion is fully complete, emit:
  #   "Closes #$SPEC_ISSUE"
  # and include the Closes #N line in the PR body so GitHub auto-closes on merge.>

<Format:
  Closes #<N>

  This PR delivers the spec at <archive path relative to repo root>.
  Spec filed: <spec_filed_at from frontmatter>>

<If partial delivery, emit instead:
  Linked to #<N> (partial delivery — not auto-closing).
  Deferred items: <list from Plan Completion>.
  Close #<N> manually after follow-up lands.>

<If no /spec archive matches this branch: omit this entire section.>

## Verification Results
<If verification ran: summary from Step 8.1 (N PASS, M FAIL, K SKIPPED)>
<If skipped: reason (no plan, no server, no verification section)>
<If not applicable: omit this section>

## TODOS
<If items marked complete: bullet list of completed items with version>
<If no items completed: "No TODO items completed in this PR.">
<If TODOS.md created or reorganized: note that>
<If TODOS.md doesn't exist and user skipped: omit this section>

## Documentation
<Embed the `documentation_section` string returned by Step 11.5's subagent here, verbatim.>
<If Step 11.5 returned `documentation_section: null` (no docs updated), omit this section entirely.>

## Test plan
- [x] <Actual project test command>: <observed passing summary>
- [x] <Other executed test lane, if any>: <observed passing summary>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

#### Redaction scan (PR body + title) — runs before create AND edit

The PR body is world-readable on a public repo. Scan-at-sink before sending:
write the composed body to a temp file, scan THAT file with the shared engine,
and pass the same file and scan digest to the closed provider adapter. Wrap any Codex / Greptile / eval output
sections in tool-attributed fences (` ```codex-review ` / ` ```greptile `) so the
engine WARN-degrades the example credentials those tools quote instead of blocking
the PR (a live-format credential inside the fence still blocks).

Apply the `RELEASE_TITLE_POLICY` resolved in Step 12. `NEW_TITLE` has already
been computed through the anchored strict title frontend for the exact existing
PR title or new-PR candidate. Do not re-read provider state or rewrite it with
an ambient helper here; use that exact final value below.

```bash
REDACT_VIS=$(~/.claude/skills/gstack/bin/gstack-config get redact_repo_visibility 2>/dev/null)
REDACT_VIS="${REDACT_VIS:-unknown}"
PR_BODY_FILE=$(mktemp) || { echo "ERROR: mktemp failed — cannot scan the PR body; refusing to create the PR unscanned." >&2; exit 1; }
cat > "$PR_BODY_FILE" <<'PR_BODY_EOF'
<PR body from above>
PR_BODY_EOF
if PR_REDACT_JSON=$(~/.claude/skills/gstack/bin/gstack-redact --from-file "$PR_BODY_FILE" --repo-visibility "$REDACT_VIS" --self-email "$(git config user.email 2>/dev/null)" --json); then
  PR_REDACT_STATUS=0
else
  PR_REDACT_STATUS=$?
fi
printf '%s\n' "$PR_REDACT_JSON"
case "$PR_REDACT_STATUS" in
  3) echo "BLOCKED — credential in PR body. Rotate + redact, do not create the PR."; exit 1 ;;
  2) echo "MEDIUM findings — confirm per finding (sterner on public) before proceeding." ;;
  0) ;;
  *) echo "BLOCKED — PR body redaction scan failed."; exit 1 ;;
esac
PR_BODY_SHA256=$(printf '%s' "$PR_REDACT_JSON" | jq -er '.body_sha256 | select(type == "string" and test("^[0-9a-f]{64}$"))') || exit 1
# If any finding is edited or auto-redacted, rerun this scan block and replace
# PR_BODY_SHA256 with the digest from the final accepted bytes.
# Also scan the title (short, single-line):
printf '%s' "$NEW_TITLE" | ~/.claude/skills/gstack/bin/gstack-redact --repo-visibility "$REDACT_VIS" --json
```

HIGH blocks (exit 3, no skip). MEDIUM → AskUserQuestion (PII subset offers
`--auto-redact`). The same scan runs before the closed provider update path (Step 19).

Create or update from the SCANNED file (exact bytes scanned = bytes sent). The
closed adapter selects the attested `gh` or `glab` binary, uses the exact numbered
PR/MR for updates, and returns an exact provider identity for ShipReceipt:

```bash
# NEW_TITLE has already passed the exact trusted release title policy.
if [ "$PR_EXISTS" = "1" ]; then
  PROVIDER_PR_ACTION_ARGS=(update --pr "$PR_NUMBER")
else
  PROVIDER_PR_ACTION_ARGS=(create --base <base>)
fi
PROVIDER_PR_JSON=$($GSTACK_ANCHOR_INVOCATION gstack-effect-scope provider-pr \
  "${PROVIDER_PR_ACTION_ARGS[@]}" --skill ship --provider "$PROVIDER_KIND" \
  --title "$NEW_TITLE" --body-file "$PR_BODY_FILE" --assert-body-sha256 "$PR_BODY_SHA256" \
  "${PROVIDER_TITLE_ASSERTIONS[@]}" --json) || exit 1
rm -f "$PR_BODY_FILE"

RESULT_PROVIDER=$(printf '%s' "$PROVIDER_PR_JSON" | jq -er '.result.provider') || exit 1
RESULT_PR_NUMBER=$(printf '%s' "$PROVIDER_PR_JSON" | jq -er '.result.number | select(type == "number" and . > 0)') || exit 1
RESULT_PR_URL=$(printf '%s' "$PROVIDER_PR_JSON" | jq -er '.result.url | select(type == "string" and length > 0)') || exit 1
[ "$RESULT_PROVIDER" = "$PROVIDER_KIND" ] || { echo "BLOCKED — provider identity mismatch"; exit 1; }
[ "$PR_EXISTS" != "1" ] || [ "$RESULT_PR_NUMBER" = "$PR_NUMBER" ] || { echo "BLOCKED — PR/MR identity moved"; exit 1; }
PR_NUMBER=$RESULT_PR_NUMBER
PR_URL=$RESULT_PR_URL
printf '%s\n' "$PR_URL"
```

**If neither CLI is available:**
Print the branch name and remote URL, instruct the user to create the PR/MR
manually, and stop before ShipReceipt. Rerun `/ship` after an attested provider
CLI can read the exact PR/MR; never invent `PR_NUMBER` from a web-only handoff.

**Output the PR/MR URL** — then proceed to Step 20.

---
