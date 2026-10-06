<!-- AUTO-GENERATED from pr-body.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 19: Create PR/MR

Recheck Step 18's PR/MR lookup and record it. Errors or ambiguous matches STOP publication.
If the open PR/MR or title changed, repeat Step 18's identity/title preparation,
then return here for a new lookup, fresh body and both redaction scans before publishing.

### Resolve Linked Spec before composing the body

1. Resolve the archive directory and branch:
   ```bash
   GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
   SLUG=$(~/.claude/skills/gstack/bin/gstack-slug --get SLUG)
   CURRENT_BRANCH=$(git branch --show-current)
   SPEC_ARCHIVES="$GSTACK_STATE_ROOT/projects/$SLUG/specs"
   ```
2. Read archive frontmatter as data, never shell source. Select an exact
   `spec_branch` match to `CURRENT_BRANCH`; among matches use the newest
   `spec_filed_at`. Never infer an issue number from a branch name. If no readable
   match or positive integer `spec_issue_number`, omit only `## Linked Spec` and
   continue composing the PR. Resolve ambiguous matches before linking an issue.
3. Compare that spec's acceptance criteria with Step 8's results. Only fully
   completed Step 8 plan scope permits `Closes #N`, with every spec criterion
   verified. Partial, deferred, failed, dropped or unverified scope uses `Linked to #N`
   and names the remaining work; never auto-close it. Include the archive filename
   and `spec_filed_at`, not a private absolute path. Send these fields through the same redaction scan.

The PR/MR body should contain these sections (never reuse a prior run's body):

```
## Summary
<Read `git log origin/<base>..HEAD --oneline`. Group every substantive commit by
theme, excluding VERSION/CHANGELOG bookkeeping. Do not paste the commit list.>

## Test Coverage
<coverage diagram from Step 7, or "All new code paths have test coverage.">
<If Step 7 ran: "Tests: {before} → {after} (+{delta} new)">
<If Step 7 ran: "Coverage: {X}% value-weighted ({Y}% including {W} weakly covered paths)">
<If Step 7 ran: "Test value: {K} tests written, {R} rejected by the authoring gate, {E} existing tests extended, {W} paths weakly covered (weak = ★, gate-failing or unrated)." Use the singular noun for a count of 1 ("1 test written", "1 existing test extended", "1 path weakly covered").>
<Weak paths and leftover gaps as proposed tests with value cards; each regression test's
"Regression proof — fails at HEAD · passes at base · passes after fix" line; Test value
details for cards whose file type has no known comment syntax.>

## Pre-Landing Review
<findings from Step 9 code review, or "No issues found.">
<Outside review: its verdict; `unverified` or `unavailable` is listed as missing coverage with its reason, never as passed.>

## Exploratory QA
<Step 9's current surfaces/charters, reproducers, approved regressions and red/green
proof, fixes and blocked/inconclusive/not-run coverage. Never present stale or
unavailable results as passing.>

## Design Review
<If design review ran: "Design Review (lite): N findings — M auto-fixed, K skipped. AI Slop: clean/N issues.">
<Detector: "clean" | "N findings (rule-id, rule-id)" | "not installed" | "not cached" | "off" — the state the probe printed; rule ids and counts only, finding text and snippets never reach the PR body.>
<If no frontend files changed: "No frontend files changed — design review skipped.">

## Eval Results
<If evals ran: suite names, pass/fail counts, cost dashboard summary. If skipped: "No prompt-related files changed — evals skipped.">

## Greptile Review
<Step 10 complete: list comments with [FIXED] / [FALSE POSITIVE] / [ALREADY FIXED], or "No Greptile comments." for a successful empty fetch.>
<Step 10 unavailable: include `Greptile triage: UNAVAILABLE (dispatch failed)` and the actual reason.>
<Step 10 no_pr: omit this section.>

## Scope Drift
<If scope drift ran: "Scope Check: CLEAN" or list of drift/creep findings>
<If no scope drift: omit this section>

## Plan Completion
<If plan file found: completion checklist summary from Step 8>
<If Step 8 printed the not-run line: that line verbatim.>
<If plan items deferred: list deferred items>

## Linked Spec
<Closes #N only when the Linked Spec check above permits it; otherwise
"Linked to #N (partial delivery — not auto-closing)" with remaining work and
"Close #N manually after follow-up lands." Include archive filename and filed date.
Without a valid match, omit this entire section.>

## Verification Results
<Step 8.1 obligations executed at Step 9: N PASS, M FAIL, K BLOCKED, J NOT RUN,
not-applicable reasons, unresolved obligations and accepted deferrals.
Unavailable/inconclusive is never PASS.>

## TODOS
<If items marked complete: bullet list of completed items with version>
<If no items completed: "No TODO items completed in this PR.">
<If TODOS.md created or reorganized: note that>
<If TODOS.md doesn't exist and user skipped: omit this section>

## Documentation
<Embed Step 14.5's vetted nonempty `documentation_section` for this invocation:
its saved section file, inserted unchanged by the scan block's `DOCS_SECTION_FILE` lines.
A blocked audit shipped under a user exception has no section file: state its
blocked status, scope and exception here and drop the block's `DOCS_SECTION_FILE` guard
and its `cat -- "$DOCS_SECTION_FILE" && echo &&` step.>
<Always include the status and reviewed scope: updated, current, or blocked with the actual user's named risk exception. Never omit this section or reuse another invocation's audit.>

## Test plan
- [x] <Each executed test lane's command>: <observed passing summary>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

#### Redaction scan (PR body + title) — runs before create AND edit

The PR body is world-readable on a public repo. Scan-at-sink before sending:
compose the body into a temp file, scan THAT file with the shared engine,
and pass the same file to `gh`/`glab`. Wrap any Codex / Greptile / eval output
sections in tool-attributed fences (` ```codex-review ` / ` ```greptile `) so the
engine WARN-degrades the example credentials those tools quote instead of blocking
the PR (a live-format credential inside the fence still blocks).

Write the body from above into two private files: the first through the
`## Documentation` heading line, the second from `## Test plan` on.

```bash
_GT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp"
mkdir -p "$_GT" && chmod 700 "$_GT" || { echo "Not sent: cannot create $_GT for the text file." >&2; exit 1; }
_EX=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p "$(dirname "$_EX")" && { grep -qxF '/.gstack/tmp/' "$_EX" 2>/dev/null || echo '/.gstack/tmp/' >> "$_EX"; }
BODY_TOP_FILE=$(mktemp "${_GT:?}/pr-body-top.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "BODY_TOP_FILE: $BODY_TOP_FILE (name: ${BODY_TOP_FILE##*/})"
BODY_REST_FILE=$(mktemp "${_GT:?}/pr-body-rest.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "BODY_REST_FILE: $BODY_REST_FILE (name: ${BODY_REST_FILE##*/})"
```

Write the text into each printed file with your file-write tool (Claude Code's Write tool needs a Read of the empty file first), exactly as it should appear. The text never goes into a shell command, heredoc or quoted argument. If a write fails or is refused, do not send: print the cause, the file path and the command below for sending by hand.

Use Step 18's `NEW_TITLE` unchanged; its version prefix is already present.
In a new shell, restore the saved literal title before this block, and Step 14.5's
saved section file path as `DOCS_SECTION_FILE`. Substitute the printed names. The
block deletes both drafts; to change the body, write fresh ones.

```bash
: "${NEW_TITLE:?Restore the saved Step 18 title before scanning}"
: "${DOCS_SECTION_FILE:?Restore the saved Step 14.5 section file path before composing}"
REDACT_VIS=$(~/.claude/skills/gstack/bin/gstack-config get redact_repo_visibility 2>/dev/null)
[ -z "$REDACT_VIS" ] && REDACT_VIS=$(gh repo view --json visibility -q .visibility 2>/dev/null | tr 'A-Z' 'a-z')
REDACT_VIS="${REDACT_VIS:-unknown}"
PR_BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/gstack-pr-body.XXXXXX") || { echo "ERROR: mktemp failed — cannot scan the PR body; refusing to create the PR unscanned." >&2; exit 1; }
BODY_TOP_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<body-top-file-name>"
BODY_REST_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<body-rest-file-name>"
[ -s "$BODY_TOP_FILE" ] && [ -s "$BODY_REST_FILE" ] || { echo "Not scanned: $BODY_TOP_FILE or $BODY_REST_FILE is empty, so the body was never written. Write both, then rerun." >&2; exit 1; }
{ awk 1 "$BODY_TOP_FILE" && cat -- "$DOCS_SECTION_FILE" && echo && awk 1 "$BODY_REST_FILE"; } > "$PR_BODY_FILE" || exit 1
rm -f "$BODY_TOP_FILE" "$BODY_REST_FILE"
~/.claude/skills/gstack/bin/gstack-redact --from-file "$PR_BODY_FILE" --repo-visibility "$REDACT_VIS" --self-email "$(git config user.email 2>/dev/null)" --json
case $? in
  0) ;;
  3) echo "BLOCKED — credential in PR body. Rotate + redact, do not create the PR."; exit 1 ;;
  2) echo "MEDIUM findings — confirm per finding (sterner on public) before proceeding." ;;
  *) echo "BLOCKED — PR body scan failed. Repair the scanner and repeat before publication."; exit 1 ;;
esac
printf '%s' "$NEW_TITLE" | ~/.claude/skills/gstack/bin/gstack-redact --repo-visibility "$REDACT_VIS" --json
```

Check both scan results: exit 0 permits publication; exit 2 requires
AskUserQuestion per MEDIUM finding (PII offers `--auto-redact`); exit 3 blocks for
HIGH findings. Exit 1 or any other error blocks until the scanner works and both
scans pass. When visibility lookup is unavailable, including on GitLab, `unknown`
uses the scanner's public-strict policy.

For every create/edit command below, send the same scanned bytes. Never re-render
the body. In a new shell, restore the literal `PR_BODY_FILE` path and `NEW_TITLE`.

**Existing open PR/MR:** update using `gh pr edit --body-file "$PR_BODY_FILE"` (GitHub)
or `glab mr update -d "$(cat "$PR_BODY_FILE")"` (GitLab).

Update the title with the same scanned `NEW_TITLE`: `gh pr edit --title "$NEW_TITLE"` (or `glab mr update -t "$NEW_TITLE"`).

**REST fallback:** if `gh pr edit` fails with the `repository.pullRequest.projectCards` GraphQL deprecation, do not re-ask for auth. Use the SAME scanned file: `PR_NUMBER=$(gh pr view --json number -q .number)`, then `gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" -X PATCH -F body=@"$PR_BODY_FILE"`; for the title use `gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" -X PATCH -f title="$NEW_TITLE"`.

**Self-check:** re-fetch the title and assert it equals `NEW_TITLE`. Retry once if wrong, then surface any failure. Print the existing URL and continue to Step 20; do not run the create commands below.

**No open PR/MR, GitHub:**

```bash
[ -s "$PR_BODY_FILE" ] || { echo "ERROR: scanned body file missing/empty — re-run the scan block." >&2; exit 1; }
gh pr create --base <base> --title "$NEW_TITLE" --body-file "$PR_BODY_FILE"
rm -f "$PR_BODY_FILE"
```

**No open PR/MR, GitLab:**

```bash
[ -s "$PR_BODY_FILE" ] || { echo "ERROR: scanned body file missing/empty — re-run the scan block." >&2; exit 1; }
glab mr create -b <base> -t "$NEW_TITLE" -d "$(cat "$PR_BODY_FILE")"
rm -f "$PR_BODY_FILE"
```

**If neither CLI is available:**
Print the branch name, remote URL, and instruct the user to create the PR/MR manually via the web UI. Do not stop — the code is pushed and ready.

**Output the PR/MR URL** — then proceed to Step 20.

---
