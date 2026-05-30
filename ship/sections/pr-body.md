<!-- AUTO-GENERATED from pr-body.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 18: Documentation sync (via subagent, before PR creation)

**Dispatch /document-release as a subagent** using the Agent tool with `subagent_type: "general-purpose"`. The subagent gets a fresh context window — zero rot from the preceding 17 steps. It also runs the **full** `/document-release` workflow (with CHANGELOG clobber protection, doc exclusions, risky-change gates, named staging, race-safe PR body editing) rather than a weaker reimplementation.

**Sequencing:** This step runs AFTER Step 17 (Push) and BEFORE Step 19 (Create PR). The PR is created once from final HEAD with the `## Documentation` section baked into the initial body. No create-then-re-edit dance.

**Subagent prompt:**

> You are executing the /document-release workflow after a code push. Read the full skill file `${HOME}/.claude/skills/gstack/document-release/SKILL.md` and execute its complete workflow end-to-end, including CHANGELOG clobber protection, doc exclusions, risky-change gates, and named staging. Do NOT attempt to edit the PR body — no PR exists yet. Branch: `<branch>`, base: `<base>`.
>
> After completing the workflow, output a single JSON object on the LAST LINE of your response (no other text after it):
> `{"files_updated":["README.md","CLAUDE.md",...],"commit_sha":"abc1234","pushed":true,"documentation_section":"<markdown block for PR body's ## Documentation section>"}`
>
> If no documentation files needed updating, output:
> `{"files_updated":[],"commit_sha":null,"pushed":false,"documentation_section":null}`

**Parent processing:**

1. Parse the LAST line of the subagent's output as JSON.
2. Store `documentation_section` — Step 19 embeds it in the PR body (or omits the section if null).
3. If `files_updated` is non-empty, print: `Documentation synced: {files_updated.length} files updated, committed as {commit_sha}`.
4. If `files_updated` is empty, print: `Documentation is current — no updates needed.`

**If the subagent fails or returns invalid JSON:** Print a warning and proceed to Step 19 without a `## Documentation` section. Do not block /ship on subagent failure. The user can run `/document-release` manually after the PR lands.

---

## Step 19: Create PR/MR

**Idempotency check:** Check if a PR/MR already exists for this branch.

**If GitHub:**
```bash
gh pr view --json url,number,state -q 'if .state == "OPEN" then "PR #\(.number): \(.url)" else "NO_PR" end' 2>/dev/null || echo "NO_PR"
```

**If GitLab:**
```bash
glab mr view -F json 2>/dev/null | jq -r 'if .state == "opened" then "MR_EXISTS" else "NO_MR" end' 2>/dev/null || echo "NO_MR"
```

If an **open** PR/MR already exists: **update** the PR body using `gh pr edit --body-file "$PR_BODY_FILE"` (GitHub) or `glab mr update -d ...` (GitLab). Always regenerate the PR body from scratch using this run's fresh results (test output, coverage audit, review findings, adversarial review, TODOS summary, documentation_section from Step 18). Never reuse stale PR body content from a prior run. **Run the same redaction scan-at-sink (PR body + title) as the create path (Step 19) before editing — scan the temp file, then `gh pr edit --body-file` from it.**

**Always update the PR title to start with `v$NEW_VERSION`.** PR titles use the workspace-aware format `v<NEW_VERSION> <type>: <summary>` — version ALWAYS first, no exceptions, no "custom title kept intentionally" escape hatch. The shared helper `bin/gstack-pr-title-rewrite.sh` is the single source of truth for the rule.

1. Read the current title: `CURRENT=$(gh pr view --json title -q .title)` (or `glab mr view -F json | jq -r .title`).
2. Compute the corrected title: `NEW_TITLE=$(~/.claude/skills/gstack/bin/gstack-pr-title-rewrite.sh "$NEW_VERSION" "$CURRENT")`. The helper handles three cases: title already correct (no-op), title has a different `v<X.Y.Z.W>` prefix (replace it), or title has no version prefix (prepend one).
3. If `NEW_TITLE` differs from `CURRENT`, run `gh pr edit --title "$NEW_TITLE"` (or `glab mr update -t "$NEW_TITLE"`).
4. **Self-check:** re-fetch the title and assert it starts with `v$NEW_VERSION `. If it does not, retry the edit once. If still wrong, surface the failure to the user.

This keeps the title truthful when Step 12's queue-drift detection rebumps a stale version, and forces the format on PRs that were created without it.

Print the existing URL and continue to Step 20.

If no PR/MR exists: create a pull request (GitHub) or merge request (GitLab) using the platform detected in Step 0.

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
  eval "$(${ctx.paths.binDir}/gstack-paths)"
  eval "$(${ctx.paths.binDir}/gstack-slug)"
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
<Embed the `documentation_section` string returned by Step 18's subagent here, verbatim.>
<If Step 18 returned `documentation_section: null` (no docs updated), omit this section entirely.>

## Test plan
- [x] All Rails tests pass (N runs, 0 failures)
- [x] All Vitest tests pass (N tests)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

#### Redaction scan (PR body + title) — runs before create AND edit

The PR body is world-readable on a public repo. Scan-at-sink before sending:
write the composed body to a temp file, scan THAT file with the shared engine,
and pass the same file to `gh`/`glab`. Wrap any Codex / Greptile / eval output
sections in tool-attributed fences (` ```codex-review ` / ` ```greptile `) so the
engine WARN-degrades the example credentials those tools quote instead of blocking
the PR (a live-format credential inside the fence still blocks).

```bash
REDACT_VIS=$(~/.claude/skills/gstack/bin/gstack-config get redact_repo_visibility 2>/dev/null)
[ -z "$REDACT_VIS" ] && REDACT_VIS=$(gh repo view --json visibility -q .visibility 2>/dev/null | tr 'A-Z' 'a-z')
REDACT_VIS="${REDACT_VIS:-unknown}"
PR_BODY_FILE=$(mktemp)
cat > "$PR_BODY_FILE" <<'PR_BODY_EOF'
<PR body from above>
PR_BODY_EOF
~/.claude/skills/gstack/bin/gstack-redact --from-file "$PR_BODY_FILE" --repo-visibility "$REDACT_VIS" --self-email "$(git config user.email 2>/dev/null)" --json
case $? in
  3) echo "BLOCKED — credential in PR body. Rotate + redact, do not create the PR."; exit 1 ;;
  2) echo "MEDIUM findings — confirm per finding (sterner on public) before proceeding." ;;
esac
# Also scan the title (short, single-line):
printf '%s' "v$NEW_VERSION <type>: <summary>" | ~/.claude/skills/gstack/bin/gstack-redact --repo-visibility "$REDACT_VIS" --json
```

HIGH blocks (exit 3, no skip). MEDIUM → AskUserQuestion (PII subset offers
`--auto-redact`). Same scan runs before the `gh pr edit --body` path (Step 17).

**If GitHub:** create from the SCANNED file (exact bytes scanned = bytes sent):

```bash
# PR title MUST start with v$NEW_VERSION — enforced on every run, no exceptions.
# (See Step 19 idempotency block + bin/gstack-pr-title-rewrite.sh for the rule.)
gh pr create --base <base> --title "v$NEW_VERSION <type>: <summary>" --body-file "$PR_BODY_FILE"
rm -f "$PR_BODY_FILE"
```

**If GitLab:**

```bash
# MR title MUST start with v$NEW_VERSION — enforced on every run, no exceptions.
# (See Step 19 idempotency block + bin/gstack-pr-title-rewrite.sh for the rule.)
glab mr create -b <base> -t "v$NEW_VERSION <type>: <summary>" -d "$(cat <<'EOF'
<MR body from above>
EOF
)"
```

**If neither CLI is available:**
Print the branch name, remote URL, and instruct the user to create the PR/MR manually via the web UI. Do not stop — the code is pushed and ready.

**Output the PR/MR URL** — then proceed to Step 20.

---
