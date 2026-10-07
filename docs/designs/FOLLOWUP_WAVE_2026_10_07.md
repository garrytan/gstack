<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gstack/garrytan-followup-wave-oct7-autoplan-restore-20261007-144939.md" -->
# gstack follow-up wave (October 7, 2026): /autoplan works on current Claude Code, long sessions, quieter guards

## Implementation plan

### Context

Base: origin/main `db74567` (v1.91.33.0). The October 6 wave (#3057, v1.91.32.0) and GSTA-21's measurement bar (#3059, v1.91.33.0) are merged. This wave takes the items the October 6 plan deferred to TODOS.md ("Oct 6 fix-wave follow-ups") plus every issue and PR opened since that triage (#3053 to #3065). Contributor code is read as evidence only; every fix is rewritten, with `Co-authored-by` credit for the diagnosis or design it uses.

Evidence gathered for this plan (2026-10-07):
- **#3062 is real and current.** The latest Claude Code is 2.1.292; CI pins 2.1.284 (`.github/docker/Dockerfile.ci`), so CI never sees it. A headless probe on 2.1.292 with `CLAUDE_CODE_FORK_SUBAGENT=1` confirmed the Agent tool schema no longer carries `run_in_background`. The headless probe did not reproduce the journal-flush half (headless sessions flushed the pending `tool_use` before the PreToolUse hook read the journal). The reporters' timelines are from interactive and `--bg` sessions, so that half needs a PTY-driven reproduction.
- **#3060:** `bin/gstack-redact-prepush` calls `scanAddedLines(part.text, { repoVisibility: "private", sourcePath })`, never passing `selfEmail` or `repoPublicEmails`, which the engine already honors.
- **PR #3055:** `bin/gstack-brain-sync` writes `blocked` to a status file nobody reads, and one flagged file blocks every push. The contributor's machine went 18 days without a push.

The severe items share one pattern: **a guard that is right about safety but wrong about the user's situation.** /autoplan's publication guard denies with "retry" when retrying can never help, the pre-push scan flags emails already in the history, and the artifacts sync blocks everything silently over one file.

### Release promises (the finish line)

- **P1. /autoplan runs on current Claude Code, in long sessions.** On Claude Code 2.1.292 with default settings, foreground and `--bg`, /autoplan enters every phase, and a session journal over 100 MiB no longer stops it. Every denial that remains names a cause that retrying cannot fix, with the supported fallback.
- **P2. Guards stop crying wolf without getting weaker.** The pre-push scan no longer flags the pusher's own email or emails already public in the repo's history, and it names the rule and file for every MEDIUM finding. The artifacts sync holds back only the flagged file and says so at every skill start. Every relaxation keeps paired true-positive controls.
- **P3. The deferred pieces of the October 6 wave land.** Greptile reviews run in parallel during /ship, the Codex probe is an executed command, PR and issue text is posted by one argument-array helper, and the remaining free-text sites use it.

### Tier 1: must ship

**A1. #3062: /autoplan denies every native reviewer dispatch on Claude Code 2.1.29x.** Two causes, both in `autoplan/bin/phase-publication-hook.ts`:
- *Cause A, schema strip.* Claude Code journals the model's raw tool input but gives PreToolUse the schema-parsed input. With the fork-subagent gate on (the default in 2.1.29x), the Agent schema drops `run_in_background`, so a dispatch that sends it never deep-equals its journal record. Fix: for `Agent`, `nativeToolInput` drops `run_in_background` from both sides; it only selects foreground or background and cannot change the phase or prompt, which `consumption()` still binds. The phase sections stop asking for the key and say how to recover when a dispatch runs in the background.
- *Cause B, journal flush.* In interactive and `--bg` sessions, Claude Code may not write the pending `tool_use` until the PreToolUse hook returns, so the hook's 2-second poll never sees it. A lone guarded call is always denied; retrying cannot help. Fix: when the poll times out, the journal is otherwise `ready`, and every earlier record is consistent, evaluate the current call from the hook payload: tool name, `tool_use_id` and `tool_input` appended after the last journaled event. The payload comes from Claude Code itself and carries the same input the journal record would. Every other check stays exact, so a changed prompt, description or added `model` is still denied.
- Denials that remain name their cause. For example, "the journal never recorded this call and earlier records disagree" points to the fallback (run the three reviews by hand), never "retry".
- Tests: replay fixtures for both causes, built as redacted journal excerpts shaped like the reporters' timelines. A PTY-driven reproduction on 2.1.292 in a foreground session and a `--bg` session, using the existing `test/helpers/pty` harness, before and after the fix. Negative controls: a changed prompt or description, or an added model, stays denied.
- Claude Code pin: move `Dockerfile.ci`'s pin to 2.1.292, so CI exercises the version users run. Run the `autoplan-journal-drift` canary and the autoplan paid cases on it.
- Credit: @yolo-jared, @crblabs, and the reporter of #3062.

**A2. Bounded owned-journal read (#3050 follow-up, P1 in TODOS.md).** `readOwnedClaudePublicTranscript` reads the whole parent journal and refuses at 32 MiB (`too_large`); reported journals reach 52-73 MiB.
- Fix: read the journal incrementally, keeping every ownership, identity and ancestry check. The guard needs the parent session's own records: the conversation root, the ancestry chain to the current call, and the phase events since snapshot init. Stream records line by line with a bounded per-line size, keep only the records the evaluation consumes, and keep the stability checks (same file identity and size before and after).
- The `too_large` denial remains only for a single record over its bound.
- Acceptance: /autoplan's guard decides correctly on a synthetic 120 MiB journal (a real head plus padded tool results), and phase-entry latency and peak memory are measured on Linux and recorded in the PR. The free suite uses a seam that shrinks the bounds, so no multi-MiB fixture is committed.

**A3. #3060: the pre-push scan flags the pusher's own email and existing author emails.**
- Fix: the hook reads `git config user.email` into `selfEmail`. It collects author and committer emails into `repoPublicEmails`, from the remote's history (`git log --format='%ae%n%ce' <remote sha>`) and from the pushed commits, whose emails become public with the push anyway. If either git call fails, it passes nothing, which is today's behavior.
- The MEDIUM summary line names each finding's rule id and file. A count alone cannot be reviewed.
- True-positive controls: an email that is neither the pusher's nor a known author still flags, and so does an email in a file of a repo with no history.
- Credit: the reporter of #3060.

**A4. PR #3055: one flagged file silently blocks the artifacts sync.**
- Every skill start shows a stuck sync: `blocked` status, or no push for 24 hours with a non-empty queue. The `ARTIFACTS_SYNC:` line names it and the command to see why (`gstack-brain-sync --status`).
- A drain holds back only the flagged paths and pushes the rest. The invariant is unchanged: nothing matching a scanner pattern is ever committed. After holding back paths, the drain re-scans the whole staged diff, and anything short of a clean re-scan falls back to today's full unstage and `blocked`.
- A stale `.git/index.lock` left by a killed drain is cleared only when no live drain owns the drain lock. `git add` and `git reset` failures are reported instead of swallowed.
- Duplicate privacy-held queue records collapse to one per path, so the queue count means something.
- Tests: a flagged file plus a clean file (the clean one pushes), a stale index lock, and a re-scan that still flags (falls back to blocked).
- Credit: @v639dragoon.

### Tier 2: ship if green

- **B1. #3065: /context-restore picks an older checkpoint.**
  - Case 1: when the cwd is not inside a git repo, also offer checkpoints whose recorded `project_root` lies below the cwd. /context-save run from a nested repo writes a pointer in the starting directory's bucket.
  - Case 2: when another branch of the same repository holds a newer checkpoint that names the same task (its worktree is below the main tree, or the title matches), show both and propose the newer one as the continuation instead of silently taking the branch match.
  - Tests use the reported layouts. Credit: the reporter of #3065.
- **B2. #3020 (full): Greptile in parallel during /ship.** When the repo has Greptile (a `greptile.json`, or past Greptile comments on its PRs), /ship pushes and opens the PR (draft unless the user asked otherwise) right after its free tests pass. It runs its other review passes while Greptile reviews, then waits a bounded time for Greptile's comments and folds them into the same review. Without Greptile, nothing changes.
- **B3. Executed-subcommand Codex probe.** `bin/gstack-codex-probe` becomes an executable with subcommands (`select-model`, `auth`, `sandbox`, `model-probe`) that print their status lines and set no shell state. The generated preflight calls it. Sourcing keeps working for one release, for skills rendered before the upgrade, then goes. The zsh self-locate code is no longer needed in the probe.
- **B4. Argument-array posting helper.** `bin/gstack-post` posts a PR or issue comment, a reply, a title or a body from files, passing every value to `gh`/`glab` as an argument, never through a shell string. It covers the remaining free-text sites: question tuning's `--summary-stdin`, /ship's `NEW_TITLE` restore and Step 18, and `docs/gbrain-write-surfaces.md`. It also restores /plan-tune's `free_text` tune events, carried in a file.
- **B5. Readiness command.** `gstack-doctor` prints, without starting a skill: install root, Bun version against the floor, `CODEX_MODE` (with the self-locate result), the hook parse check, artifacts-sync health, and the browse server bundle. Each row carries a fix line, and it exits non-zero when any row fails. `./setup --status` gains a Codex row.
- **B6. #3063, #3064: browse cookbook clarity for Aside scripts.**
  - Before opening a tab for a target, list the open tabs and attach to a signed-in one.
  - A second sign-in wall right after a confirmed sign-in means the session is bound to the tab or URL; attach, and don't ask the user again.
  - `evaluate` returns only serializable values.
  - Don't use top-level `return`.
  - An empty DOM read is not a finding.
  - Credit the reporters.
- **B7. #3054: credit fix.** In the v1.64.0.0 CHANGELOG entry and the header of `browse/test/extension-sender-auth.test.ts`, PR #1822 is credited to @Mike-E-Log. Commit history is not rewritten.

### Not in this wave

- **Native Windows Docker transport for /cso (#3028 follow-up):** L effort, and it cannot be verified without Windows hardware. It stays in TODOS.md.
- **#3061 (stateless host mode) and #3058 (touch and mobile Safari QA):** feature proposals for a feature pass.
- **Dependabot #3053:** a routine bump outside the wave.

### Tracker hygiene

- On merge, close each fixed issue with the release, the reporter's upgrade command, and a check to confirm the fix where one exists.
- Close adopted PRs (#3055) at merge with credit.
- Close #3054 once the credit lands.

### Validation

- Each item gets a focused free test that fails on main first.
- The free suite runs once at the end on Ubicloud.
- Paid runs:
  - the autoplan paid cases on Claude Code 2.1.292;
  - the PTY reproduction for A1;
  - the PR gate;
  - for any paid red, the ship-measure loop at the #3059 bar.
- One PR, separate commits per item, patch version bump.

## Review record
