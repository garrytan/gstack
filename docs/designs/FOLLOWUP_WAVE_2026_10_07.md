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

- **P1. /autoplan runs on current Claude Code, in long sessions.** On Claude Code 2.1.292 with default settings, foreground and `--bg`, /autoplan enters every phase, and a session journal over 100 MiB no longer stops it. Every denial that remains names its cause; none advises a retry that cannot succeed, and every non-transient cause comes with the supported fallback (CEO-3).
- **P2. Guards stop crying wolf without getting weaker.** The pre-push scan no longer flags the pusher's own email or emails already public in the repo's history, and it names the rule and file for every MEDIUM finding. The artifacts sync holds back only the flagged file and says so at every skill start. Every relaxation keeps paired true-positive controls.
- **P3. The deferred pieces of the October 6 wave land.** Greptile reviews run in parallel during /ship, the Codex probe is an executed command, PR and issue text is posted by one argument-array helper, and the remaining free-text sites use it or, where they never call `gh`/`glab`, the agent-written file rule (CEO-23).

### Tier 1: must ship

**A1. #3062: /autoplan denies every native reviewer dispatch on Claude Code 2.1.29x.** Two causes, both in `autoplan/bin/phase-publication-hook.ts`:
- *Cause A, schema strip.* Claude Code journals the model's raw tool input but gives PreToolUse the schema-parsed input. With the fork-subagent gate on (the default in 2.1.29x), the Agent schema drops `run_in_background`, so a dispatch that sends it never deep-equals its journal record. Fix: for `Agent`, `nativeToolInput` drops `run_in_background` from both sides; it only selects foreground or background and cannot change the phase or prompt, which `consumption()` still binds. The phase sections and the shared foreground-dispatch note ask for the key only when the Agent schema exposes it and say how to recover when a dispatch runs in the background (CEO-20).
- *Cause B, journal flush.* In interactive and `--bg` sessions, Claude Code may not write the pending `tool_use` until the PreToolUse hook returns, so the hook's 2-second poll never sees it. A lone guarded call is always denied; retrying cannot help. Fix: when the first complete read of a `ready` journal lacks the current call and every earlier record is consistent, evaluate the current call from the hook payload: tool name, `tool_use_id` and `tool_input` appended after the last journaled event, for both `Read` and `Agent`; a phase transition counts only a report published in an earlier assistant message (CEO-1). The payload is Claude Code's own schema-normalized input, trusted but not byte-identical to the journal (Cause A shows the difference), so CEO-13 checks its key set against the journal on every new release. A changed prompt or an added `model` is denied on both paths, and a changed description on the journal path (CEO-1).
- Denials that remain name their cause. For example, "the journal never recorded this call and earlier records disagree" points to the fallback (run the three reviews by hand), never "retry".
- Tests: replay fixtures for both causes, built as redacted journal excerpts shaped like the reporters' timelines. A PTY-driven reproduction on 2.1.292 in a foreground session and a `--bg` session, using the existing `test/helpers/pty` harness, before and after the fix. Negative controls: a changed prompt or an added model stays denied on both paths, and a changed description on the journal path.
- Claude Code pin: move `Dockerfile.ci`'s pin to 2.1.292, so CI exercises the version users run. Run the `autoplan-journal-drift` canary and the autoplan paid cases on it.
- Credit: @yolo-jared, @crblabs, and the reporter of #3062.

**A2. Bounded owned-journal read (#3050 follow-up, P1 in TODOS.md).** `readOwnedClaudePublicTranscript` reads the whole parent journal and refuses at 32 MiB (`too_large`); reported journals reach 52-73 MiB.
- Fix: read the journal incrementally, keeping every ownership, identity and ancestry check. The guard needs the parent session's own records: the conversation root, the ancestry chain to the current call, and the records of the current invocation, from the human turn that started it (CEO-2). Stream records line by line with a bounded per-line size, keep only the records the evaluation consumes, and keep the identity checks (same device and inode, no shrink) on an append-tolerant prefix read (CEO-2).
- The `too_large` denial remains only for a single record over its bound.
- Acceptance: /autoplan's guard decides correctly on a synthetic 120 MiB journal (a real head plus padded tool results), and phase-entry latency and peak memory are measured on Linux and macOS (CEO-6) and recorded in the PR. The free suite uses a seam that shrinks the bounds, so no multi-MiB fixture is committed.

**A3. #3060: the pre-push scan flags the pusher's own email and existing author emails.**
- Fix: the hook reads `git config user.email` into `selfEmail`. It collects author and committer emails into `repoPublicEmails`, from the remote's history (`git log --format='%ae%n%ce' <remote sha>`, or the push remote's tracking refs for a new branch or unknown remote tip, CEO-7) and from the pushed commits, whose emails become public with the push anyway. If either git call fails, it omits only that input, which is today's behavior for it (CEO-23).
- The MEDIUM summary line names each finding's rule id, file and line (CEO-7). A count alone cannot be reviewed.
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
- **B2. #3020 (full): Greptile in parallel during /ship.** When the repo has Greptile (a `.greptile/` folder, a `greptile.json`, or past Greptile comments on its PRs), /ship pushes and opens the PR (draft unless the user asked otherwise; a draft gets one `@greptileai` trigger comment when Greptile skips drafts, CEO-8) right after its free tests pass. It runs its other review passes while Greptile reviews, then waits a bounded time for Greptile's comments and folds them into the same review. Without Greptile, nothing changes.
- **B3. Executed-subcommand Codex probe.** `bin/gstack-codex-probe` becomes an executable with one subcommand per probe function (CEO-9 lists them) that print their status lines and set no shell state. The generated preflight calls it. Sourcing keeps working for one release, for skills rendered before the upgrade, then goes. The zsh self-locate code goes in the same change that drops sourcing (CEO-9).
- **B4. Argument-array posting helper.** `bin/gstack-post` posts a PR or issue comment, a reply, a title or a body from files, passing every value to `gh`/`glab` as an argument, never through a shell string. It covers /ship's `NEW_TITLE` restore and Step 18; question tuning's `--summary-stdin` and `docs/gbrain-write-surfaces.md` move to the agent-written file rule (CEO-23). It also restores /plan-tune's `free_text` tune events, carried in a file.
- **B5. Readiness command.** `gstack-doctor` prints, without starting a skill: install root, Bun version against the floor, `CODEX_MODE` (with the self-locate result), the hook parse check, artifacts-sync health, and the browse server bundle. Each row carries a fix line, and it exits non-zero when any row fails. `./setup --status` gains a Codex row.
- **B6. #3063, #3064: browse cookbook clarity for Aside scripts.**
  - Before opening a tab for a target, list the open tabs (the list stays private) and offer to attach to a signed-in one, attaching only after the user confirms it once (CEO-10).
  - A second sign-in wall right after a confirmed sign-in means the session is bound to the tab or URL; propose attaching to the user's signed-in tab instead of asking for another sign-in (CEO-10).
  - `evaluate` returns only serializable values.
  - Don't use top-level `return`.
  - An empty DOM read is not a finding.
  - Credit the reporters.
- **B7. #3054: credit fix.** In the v1.64.0.0 CHANGELOG entry and the header of `browse/test/extension-sender-auth.test.ts`, PR #1822 is credited to @Mike-E-Log, and the CHANGELOG entry credits PR #1743 to @habassa5 (CEO-11). Commit history is not rewritten.

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
  - the PR gate, and the full gate tier on the new Claude Code pin (CEO-4);
  - the long-session PTY case past 100 MiB (CEO-15), one manual dispatch of the latest-release schema canary (CEO-13), and the macOS measurement step (CEO-6);
  - for any paid red, the ship-measure loop at the #3059 bar.
- One PR, separate commits per item, patch version bump.

### Accepted review amendments

Each amendment below was accepted by the /autoplan review. The item text above names the amendment it folds in; where they differ, the amendment's conditions and tests apply.


<!-- autoplan-accepted:ceo -->
- CEO-1 (A1 Cause B, payload-backed current call and flush-safe publication). The payload path covers both guarded tools, `Read` and `Agent`, and replaces the pending-Read rule that refuses to establish a phase from the hook payload. On the first complete read of a `ready` journal that lacks the current `tool_use_id`, with every journaled record passing the existing order, identity and ownership checks, the guard evaluates the call from the payload (`tool_name`, `tool_use_id`, `tool_input`) placed after the last journaled record, which anchors ancestry. It does not wait out the 2-second window first (claude-code#100051: in lagging sessions the record arrives only with the tool result); the window remains only for a journal that does not exist yet and for the unrecognized-shape double read. A new phase may be established only if the previous phase's report is present in journaled records.
  Agent input binding on both paths: a constant in the hook lists the allowed Agent keys (`prompt`, `description`, `subagent_type`, `run_in_background`), so no snapshot manifest changes and snapshots made before the upgrade keep working; `prompt` must equal `nativeDispatchPrompt` (as `consumption()` checks today), `subagent_type` must be absent or `general-purpose`, and any other key, including `model`, is denied. On the journal path the journal-versus-payload comparison stays exact apart from `run_in_background` (Cause A), so a changed `description` is still caught there; on the payload path there is no second copy, so the `description` control applies to the journal path only.
  Batched calls: on the payload path the hook payload has no `messageId`, so the last journaled assistant `messageId` is treated as possibly the current call's message. Pending journaled siblings count as the same batch only if they carry that `messageId` and target the same phase; then they are not "a prior phase-entry tool still pending". A sibling that targets a different phase still denies.
  Allowlist evidence: the full schema-parsed Agent payload key set on 2.1.292 (default settings) is captured as a fixture before the allowlist is fixed, and CEO-13's canary asserts the payload keys stay inside it.
  Publication flush: because text in the same assistant message as a guarded call is invisible to the hook in lagging sessions, a phase transition on either path counts only a report that a later journaled record follows, either a tool result or a record with a different `messageId`; a report in the last journaled assistant message with nothing after it does not count on the payload path. The outcome therefore never depends on flush timing. Phase-close step 6 publishes the phase report in a message whose only tool call is the no-op Bash `: autoplan-published <phase>` (no output, unguarded), and step 7 makes the next guarded `Read` or `Agent` (the next phase driver, or the Phase 4 tasks aggregator after any skip messages) go in a later message. When a payload-path phase entry finds no journaled report, the denial names that cause and says to publish the report in its own message with that no-op call; it never says "retry".
  Tests: replay fixtures shaped like the #3062 timelines (the `--bg` Read batch at offsets 1, 601 and 1201, and a lone foreground `Agent` dispatch) are denied on main and allowed after the fix; a phase transition whose report shares a message with the guarded `Read` on a lagging journal gets the publish-separately denial, the same report in the same message is denied on a fully flushed journal too, a partial flush (the current message's text journaled, its `tool_use` not) is denied, and the transition after the no-op call is allowed; a same-phase sibling batch is allowed and a cross-phase sibling is denied. Negative controls stay denied: a changed prompt on either path, an added `model` on either path, a changed `description` on the journal path, and a payload-path call that would enter a new phase without a journaled report.
- CEO-2 (A2 bounded, append-tolerant read). Approach: the hook gets its own two-pass owned reader. Pass one streams the file up to the size observed at open, ending at the last complete line, and keeps a small index per record (uuid, parent uuid, record kind, byte offset and length). Ownership, ancestry and order checks run on index metadata: uuid, parent and logical parent uuid, type and subtype, SessionStart attachment flag, `isSidechain`, `agentId`, cwd, timestamp validity, message role, `messageId`, the class of each user turn (typed, `/autoplan` slash, other), each `tool_use` name and id, and the command string of each Bash `tool_use` (so `initArguments` can find literal inits). Pass two loads full records only for the invocation window: from the latest human `user_turn` at or before the first non-reused literal init of the currently bound invocation chain (a `reused:true` init keeps the earlier binding, as `invocation()` does today), so runs started by a typed request or the Skill tool still bind init and a re-arm keeps an outstanding publication. A flag records whether an `end_turn` precedes that turn for `disarmed()`. The existing tests "a real same-restore init re-arms without erasing an outstanding publication" and "rearm excludes disarmed future Reads" stay as controls. Per-record event extraction moves into one shared module, `lib/claude-journal-records.ts`, called by both this reader and `readPlanCountTranscript`, so the two cannot drift. `readPlanCountTranscript` and its batch callers (tests and PTY runners) keep their current reader and 32 MiB cap. Appends after open never fail the read; the same device and inode and no shrink are required. Within one hook invocation, a second read compares the sha256 of bytes [0, first size) with the first read; a mismatch is a hard denial naming a rewritten journal plus the supported fallback. Rewrites between hook invocations are not detected (accepted limit, documented). The unverified-entry advisory's two-read stability check uses that same prefix hash, and the diagnostic pass is streamed so memory stays bounded. Per-record bound: 32 MiB (the old whole-file cap, so no journal readable today becomes unreadable), a named constant documented in `docs/autoplan-guard-troubleshooting.md`; any single record over it yields `too_large`.
  Acceptance (recorded in the PR, not a CI timing gate): `scripts/measure-journal-read.ts` builds a 120 MiB journal whose record count and size mix match the reported journals (not only a few large records; the review's 440-500 ms figure came from the current full reader on a 5.7k-record synthetic), appends during the read, and measures one read plus evaluation. On a GitHub-hosted `ubuntu-latest` runner (4 vCPU) it must take at most 1 s with peak RSS at or under 256 MiB; a parse-and-index spike on that journal runs before the reader design is committed; the free suite asserts the decision and the bounded index size through the shrink seam, plus a fixture for a Skill-tool start with no slash turn. A run that misses either threshold holds the A2 commit (Tier 1 holds the PR) until it is fixed or the user grants an explicit exception.
- CEO-3 (P1 denial inventory and codes). Every `fail()` site in `autoplan/bin/phase-publication-hook.ts` gets a stable reason code, and the PR lists each with its disposition: removed by A1/A2; a non-transient cause with the supported fallback; a named corrective action the user or model must take first (for example "restore this installation", "run init", "publish the report"); or a named transient that says what to wait for (today "a prior phase-entry tool is still pending" and "an active-plan mutation is pending"). A free test fails on any denial text that advises a retry without naming its corrective action or transient condition.
- CEO-4 (pin bump validation). Moving `.github/docker/Dockerfile.ci` to Claude Code 2.1.292 runs the full gate tier (`bun run eval:bg:gate`) on the new pin, as the Dockerfile's own comment requires ("runs the PTY gate against the new TUI"), in addition to the autoplan paid cases and `autoplan-journal-drift`. The pin comment records why 2.1.292 was chosen, and `test/ci-image-cli-pin.test.ts` passes.
- CEO-5 (`--bg` reproduction honesty). The PTY reproductions run with default settings (no `CLAUDE_CODE_FORK_SUBAGENT` override, clean config). One starts a session with `claude --bg` and drives it through `claude attach <id>`. If the harness cannot drive an attached session, the PR and release notes state that P1's `--bg` case was verified only by replay fixtures, and skipped item X10 (a `--bg` preflight warning) is reopened as a TODOS.md entry. The foreground session also prints whether `$CLAUDE_PROJECT_DIR` is set inside a Bash tool call, recorded in the PR for CEO-22.
- CEO-6 (macOS measurement). `scripts/measure-journal-read.ts` runs once through a `workflow_dispatch` job on `ubuntu-latest` and `macos-latest` on the A2 branch (not on every PR); the macOS numbers are recorded in the PR next to the Linux numbers and do not gate.
- CEO-7 (A3 remote history for new branches). When the pushed remote sha is all zeros or not present locally, `repoPublicEmails` comes from the push remote's tracking refs (`git log --format='%ae%n%ce' --remotes=<remote>`) plus the pushed commits. Every history read, including the normal `<remote sha>` path, is bounded to 50,000 commits and 5 seconds; any failure or overrun passes nothing (today's behavior). The MEDIUM summary names each finding's rule id, file and line, never the matched value.
- CEO-8 (B2 Greptile lifecycle). Greptile is detected by `greptile.json` or a `.greptile/` folder (the folder takes precedence), or past Greptile comments. When /ship opens the early PR as a draft and the effective config does not set `triggerOnDrafts: true`, /ship posts one `@greptileai` comment to start the review. /ship marks the PR ready at its existing PR step unless the user asked for a draft; the review Greptile starts on "ready" is expected, is not awaited, and its comments are handled by the next /ship or /land-and-deploy Greptile pass, so no extra comment is posted to trigger it. Completion signal: /ship polls every 30 seconds for Greptile's check run or summary comment on the early PR's head SHA, for at most 10 minutes; only a completed check or summary counts as a finished review (zero comments allowed), and a timeout takes the existing unavailable path, never a claim of zero comments. The early draft carries the provisional title and a body saying /ship opened it early for review and will update it; the existing PR step edits that PR instead of creating one. Comments on an earlier head are triaged against the final diff. The trigger comment goes through `gstack-post` when B4 ships; otherwise through `gh pr comment --body-file` with a file written by the host's file tool (the existing free-text rule). Without Greptile nothing changes. Tests: fixture repos with and without `triggerOnDrafts` and with a `.greptile/` folder assert whether the trigger comment is posted.
- CEO-9 (B3 every probe function has an executed form). Each of the ten probe functions generated skills call today gets a subcommand: `select-model`, `auth`, `sandbox-mode`, `sandbox-preflight`, `model-probe`, `version-check`, `first-use-notice`, `timeout` (execs the wrapped command and returns its exit code), `log-event` and `log-hang`. Contract (stdout `KEY: value` lines; human status lines stay on stderr as today; nothing is set in the caller): `select-model <exec|review>` prints `CODEX_SEL:` and `CODEX_SEL_KIND:`, keeps the `CODEX_MODEL:` stderr line, exits 0 or 1; `sandbox-mode` prints `CODEX_SANDBOX:`; `sandbox-preflight` exits 0 or non-zero with the reason on stderr; `model-probe <exec|review> --model <m> --kind <k>` prints `CODEX_PROBE_STATE:` and keeps today's exit codes (0, 2, 3, other); `auth` reports by exit code; `version-check` and `first-use-notice` print to stderr and exit 0; `timeout <secs> <cmd...>` execs the command and returns its exit code (124 on timeout); `log-event <event> [detail]` and `log-hang <skill> <n>` print nothing and exit 0. Generated blocks capture a value with `sed -n 's/^KEY: //p'`, so `CODEX_MODEL_CONFIG_FLAG` reads the captured model instead of `${_GSTACK_CODEX_SEL}`. Sourcing keeps working for one release for skills rendered before the upgrade; the zsh self-locate code stays while sourcing is supported and is removed in the same change that drops sourcing. The existing zsh sourcing test keeps passing during the compatibility release, and a free test runs each subcommand once from bash and zsh.
- CEO-10 (B6 consent kept). Attaching to a tab the agent did not open still requires the user to confirm that tab once (rule 1). The agent may show the user only tabs whose origin equals the target origin the user named (title and origin); the rest of `listBrowserTabs()` stays private. After a confirmed sign-in, a second sign-in wall means the session is bound to the tab or URL: the agent proposes attaching to the user's signed-in tab with that one confirmation instead of asking for another sign-in. Rule 6 no longer suggests an early `return`; key presses use `pg.locator(sel).press(key)`; an `[ok` result from a very short run with no `GSTACK_STEP_OK` is a script abort. Rule text stays short because it renders into about 100 generated skill files; the details go in the browse cookbook.
- CEO-11 (B7 second credit). In the v1.64.0.0 CHANGELOG entry, @punksterlabs is replaced by @Mike-E-Log for the extension token fix (#1822) and by @habassa5 for the polyfill `exited` promise (#1743). Commit history is not rewritten.
- CEO-12 (guard decision log). Every guarded decision, allow or deny, appends one content-free line to `<state root>/analytics/autoplan-guard.jsonl` with the decision, the CEO-3 reason code for a denial, the evaluation path (journal or payload), the Claude Code version and the disposition class, so denials have a denominator; a logging failure never changes the decision. A free test checks the line for one allow, one hard denial and one transient denial.
- CEO-13 (latest-release schema canary). A new periodic case `autoplan-schema-canary` (own test file, `touchfiles-data.ts` entry, periodic tier, rule kind) runs inside the CI image from `.github/workflows/evals-periodic.yml` on a daily schedule added for this case alone (existing `ANTHROPIC_API_KEY` secret, haiku, about $0.02 a run, about $0.60 a month); the weekly matrix is unchanged. It installs the latest published Claude Code into a temporary npm prefix (selected through `GSTACK_CLAUDE_BIN`), runs a headless session whose PreToolUse hook records the payload for one `Agent` and one `Read` call, and after the turn compares each payload with its journal record using the guard's own comparison (`nativeToolInput` is exported for it), asserts the payload keys stay inside CEO-1's allowlist, and asserts that the payload's key set equals the journal record's key set except for documented strips (today `run_in_background`) for both tools, so a schema strip like Cause A fails CI within a week of a release and reaches the existing periodic `report` job like any red case. The new case has no pin assertion; `autoplan-journal-drift` keeps its pin assertion unchanged. Flush timing is out of its reach (headless) and stays covered by CEO-5. A free fixture proves the comparison fails on an injected key strip. It is proven before merge by one manual dispatch on the PR branch and run again on merge day against the latest release, both linked in the PR.
- CEO-14 (sync status detail). `gstack-brain-sync --status` JSON gains a `held` array with each held path, the scanner rule name (never the matched text) and both fixes (`gstack-brain-sync --skip-file <path>`, or edit the content). A free test covers one held path.
- CEO-15 (P1 long-session end to end). One paid PTY case (rule kind, one trial, inside the ~10-minute eval budget) resumes a session whose journal has been padded past 100 MiB with records before a compact boundary (which Claude Code does not replay to the API) and enters /autoplan Phase 1 through the guard; its cost is estimated in the PR before it runs. If Claude Code cannot resume a padded journal, the PR says P1's long-session promise was verified only through the reader acceptance in CEO-2.
- CEO-16 (TODOS.md edits). The implementation PR removes each "Oct 6 fix-wave follow-ups" entry only when its item ships and meets that entry's acceptance (the bounded-read entry needs CEO-15 to pass end to end; otherwise it is reworded to the remaining gap); Tier 2 items that do not ship keep their entries. It keeps the /cso Windows transport entry, adds X7 and X8 with their deferral reasons, and adds X10 when CEO-5 reopens it.
- CEO-17 (A4 health signal and lock safety). Scanner holds: a drain that holds back flagged paths and pushes the rest writes the new status `held` (not `blocked`) with the held count; held records stay queued and are re-scanned on every drain until the content is clean or `--skip-file` names the path. Skill start shows an attention line whenever the status is `held` or `blocked`, and separately when no push happened for 24 hours while drainable records wait; scanner-held and privacy-held records never count as drainable. The drain writes a `drainable` count into the status file so skill start does not need the privacy classification. The `ARTIFACTS_SYNC:` attention line is fixed text plus a status code clamped to `ok`, `idle`, `held`, `blocked`, `push_failed` or `error` (anything else prints `unknown`), never the status message, file paths or scanner output (the status message can hold the first 30 characters of a matched secret). A stale `.git/index.lock` is removed only while this drain holds the drain lock and the index lock is older than 10 minutes, because `gstack-brain-restore`, `gstack-artifacts-init` and `gstack-gbrain-source-wireup` run git in `$GSTACK_HOME` without that lock. Per-path holds attribute scanner hits by scanning each staged path's diff. Tests: a held file reported at skill start while other files keep pushing, a held file cleared by editing and by `--skip-file`, a privacy-held queue without the alarm, a fresh index lock left alone, an old one cleared, and an attention line that contains no status text.
- CEO-18 (generation and prompt checks per template item). Every item that edits a template or resolver (A1 phase sections and phase-close, B2, B3, B4, B6, CEO-20, and CEO-17's `scripts/resolvers/preamble/generate-brain-sync-block.ts`, which tells the model to surface the new attention line to the user and continue) regenerates with `bun run gen:skill-docs` and `bun run gen:skill-docs --host codex`, and passes `test/parity-suite.test.ts`, the prompt-size checks and the golden fixtures before its paid eval.
- CEO-19 (B4 owns the redaction scan). `gstack-post` runs `gstack-redact` on the exact bytes it is about to send, with `--repo-visibility` from the caller's existing visibility detection and `--self-email` from `git config user.email`. It refuses on a HIGH finding with the rule names; on a MEDIUM finding (exit 2) it posts nothing and returns the findings so the caller asks its existing per-finding question before posting; and the callers it replaces (/ship's PR title and body scan in `ship/sections/pr-body.md.tmpl`, and the PR or issue write sites rendered from `scripts/resolvers/redact-doc.ts`) drop their separate scans. Tests: a HIGH secret in a body file is refused and nothing is posted; a MEDIUM finding posts nothing until the caller confirms; a clean body posts with argument-array `gh` invocation verified by a stub.
- CEO-20 (shared foreground note). Every site that requires `run_in_background: false` adopts the conditional wording `spec-review.ts:154` already uses ("if that field is available; omit it otherwise") plus the recovery for a background run: `FOREGROUND_DISPATCH_NOTE` in `scripts/resolvers/constants.ts`, `scripts/resolvers/design.ts` (two sites), `outside-voice-steps.ts` (three sites), `review-army.ts` (two sites), `spec-review.ts:61`, and the three templates that inline the literal (autoplan `ceo-phase`, `cso`, `design-shotgun`). The bounded-wait dispatch that sets `run_in_background: true` (`outside-voice-steps.ts:482`) is unchanged.
- CEO-21 (doctor spends nothing by default). `gstack-doctor` never runs the paid Codex model probe by default: it reports the cached result with its age, or "not probed", and runs the live probe only with `--live`.
- CEO-22 (B1 definitions). Case 2's task match is a worktree path below the main tree, equal normalized checkpoint titles (lowercased, whitespace collapsed, punctuation and a leading date removed), or the same ticket token (`#123` or `ABC-123`) in both checkpoints' titles or branch names. Case 1's pointer is a JSON file in the starting directory's bucket holding the checkpoint path, its bucket and `project_root`; the starting directory is `$CLAUDE_PROJECT_DIR` when set in the Bash tool environment (CEO-5 records whether it is), and when it is unset no pointer is written (the below-cwd scan still finds the checkpoint).
- CEO-23 (A3 independent fallbacks and B4 site scope). A3's two inputs fail independently: a failed `git config user.email` omits only `selfEmail`, and a failed or bounded-out history read omits only `repoPublicEmails`. B4's `gstack-post` covers the PR and issue sites; question tuning's `--summary-stdin` and the `docs/gbrain-write-surfaces.md` heredocs move to the agent-written file rule instead, since neither calls `gh` or `glab`.
- CEO-24 (PTY-first gate and live phase transitions). Before CEO-1's payload path is built, the foreground PTY reproduction (2.1.292, default settings) runs against main and records whether the lone guarded call's record is missing at hook time, confirming the flush mechanism the design assumes. After the fix, the PTY run drives /autoplan through every phase transition in the foreground, and through `claude attach` for `--bg` when CEO-5 can drive it, including one transition that uses the `: autoplan-published <phase>` no-op on a lagging session. For any promised mode that cannot be verified live, the PR narrows P1 for that mode and #3062 stays open for it.
- CEO-25 (tail-read spike). Before CEO-2's reader design is committed, a spike measures a backward read from end of file that stops at the invocation window start and the latest compact boundary, plus a head read for the root and SessionStart checks. The design that proves the same ownership, ancestry and order checks at lower cost is adopted, and the PR records why the other was rejected.
- CEO-26 (admission cutoff inside the one PR). The mandatory set is Tier 1, the CEO-4 pin bump and any runtime or harness repair they need. Tier 2 items are admitted only after the mandatory set is green; a Tier 2 item still red after one repair round is reverted as its own commit and moves to TODOS.md, and P3 is reported per item that shipped. The selected eval schedule and its cost estimate are written into the PR before Tier 2 is admitted.
- CEO-27 (A4 coupled artifacts and drain liveness). A held path holds its coupled group (artifacts that reference each other, such as a decision log and its active snapshot, as listed from the sync allowlist), so the remote never receives a partial generation. Acceptance restores onto a second `GSTACK_HOME` with a held dependency and checks the consumers read a consistent state. The drain writes `last_drain_at`; skill start alarms when it is older than 24 hours and the queue holds records, without trusting the drain's own counts. Tests: a held decision log holds its snapshot; the drain never running raises the alarm.
- CEO-28 (outside-review severity words). `lib/outside-review-result.ts` counts severity words (`critical`, `high`) as blocking findings in review-gate outputs, or every outside-voice prompt requests `[P0]`-`[P3]` tags and the classifier treats untagged findings as `unverified`, so a review that lists high-severity findings is never reported `VERDICT: clean`. A regression fixture uses the shape of this run's Codex CEO output (seven "High"/"Medium" findings classified `clean`, `FINDINGS: none` by the installed 1.91.29.0 classifier).
- CEO-29 (doctor triage rows). `gstack-doctor` also prints the Claude Code version, the size of the largest session journal for the current project, and the last five guard reason codes from `autoplan-guard.jsonl`; the bug-report issue template asks for its output.
- CEO-30 (upstream request). The PR links an anthropics/claude-code issue (new, or a comment on #100051) asking for the assistant `messageId` or a flushed-before-hook guarantee in the PreToolUse payload, the supported surface that would retire the payload heuristics.
- CEO-31 (contributor tests). Contributor code stays evidence and every fix is rewritten; contributors' regression tests are reused, adapted to the rewrite, when they pass review, and the PR says why any was not.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- DX-1 (guard troubleshooting page is a deliverable). `docs/autoplan-guard-troubleshooting.md` is rewritten with the guard changes: one anchor per CEO-3 reason code; the "Retry denials" section becomes CEO-3's dispositions (no "retry the same tool" for `identity` or `malformed`); the `too_large` section matches the bounded reader; the "no environment variable turns the guard off" line stays unless the user changes it at the gate. Every denial message ends with its anchor URL and prints the fallback as runnable commands (`/plan-ceo-review`, then `/plan-devex-review`, then `/plan-eng-review`; or `/context-save`, a new session, `/context-restore`, then `/autoplan <plan path>`). The `model` or extra-key denial says that a model override is not allowed for /autoplan reviewer dispatch. `docs/troubleshooting.md` stops teaching the sourced probe once B3 ships. CEO-3's free test also asserts that every code has an anchor and every denial string cites one.
- DX-2 (runnable paths). Every user-facing mention of a gstack helper (the `ARTIFACTS_SYNC:` attention lines, doctor's fix lines, the bug-report issue template, CHANGELOG recovery steps, denial fallbacks) prints the absolute path resolved from the install root, not a bare `gstack-*` name; the issue template gives the Claude Code path plus a `gstack-paths` lookup for other hosts. A free test asserts that rendered attention lines and the template contain no bare `gstack-` command.
- DX-3 (upgrade in place). Release notes say an upgrade needs no restart: an in-flight /autoplan session may get at most one publish-separately denial, which names the exact fix, and `CLAUDE_CODE_FORK_SUBAGENT=false` is no longer needed (harmless if kept). A replay fixture runs an old-template close sequence (report and next driver `Read` in one message) against the new hook and shows recovery after the denial without a restart.
- DX-4 (one sync status table). The plan's three staleness predicates are replaced by one table in `bin/gstack-brain-sync`'s usage header and the docs: `held` (scanner hold, held count), `blocked` (re-scan still flags), `push_failed`, `error`, stale-push (no push for 24 hours while the drain's `drainable` count is above zero), stale-drain (`last_drain_at` older than 24 hours while the queue directory holds records), each with its trigger, exact fixed attention-line text and fix command; `ok` and `idle` print no attention line. The skill-start tests are generated from that table.
- DX-5 (skip is permanent and reversible). `held` entries and the docs say `--skip-file` permanently excludes the path from future syncs, and a new `gstack-brain-sync --unskip-file <path>` reverses it. Each held group lists its blocking path and its held dependents. A test unskips a path and shows normal syncing resumes without publishing a partial group.
- DX-6 (`gstack-post` interface). Synopsis: `gstack-post {pr-comment|issue-comment|reply|pr-title|pr-body} <target> --body-file <file> [--host github|gitlab] [--confirm <rule-id>...]`; the host is detected from the remote unless `--host` is given. Exit codes: 0 posted; 1 HIGH finding refused; 2 MEDIUM findings need confirmation, printed on stdout as `RULE: <id> LINE: <n>` lines; 3 `gh`/`glab` failed. `--confirm` must name exactly the rule ids returned for those bytes; the helper re-scans every call, so changed bytes need a fresh confirmation and a HIGH finding is always refused. Tests: refusal then confirmation then post; changed content after confirmation re-prompts; HIGH refused even with `--confirm`.
- DX-7 (probe subcommand naming and help). Subcommands use one verb-first order: `select-model`, `check-auth`, `show-sandbox`, `check-sandbox`, `probe-model`, `check-version`, `show-first-use-notice`, `run-with-timeout`, `log-event`, `log-hang`, plus `help`; an unknown subcommand prints usage to stderr and exits 64. `select-model <exec|review> [--model <id>]` keeps today's precedence (per-request model over environment over config) and provenance, and the same model is used for probing and dispatch. While sourcing is still supported, sourcing prints one stderr line naming the deprecation and `/gstack-upgrade`.
- DX-8 (doctor result states). Each `gstack-doctor` row is `ok`, `warn`, `not configured` or `fail`; only `fail` makes the exit code non-zero. Intentionally absent Codex, disabled artifacts sync, an unbuilt optional browser and "not probed" are `not configured` or `warn` with the affected features named. Doctor's install row reuses the `./setup --status` check, and `./setup --status` ends with the absolute path to `gstack-doctor`.
- DX-9 (A3 partial history and fix lines). Hitting the 50,000-commit cap uses the partial author set; only an error or the 5-second timeout passes nothing, and either case prints one line saying existing-email suppression was limited for this push. Each MEDIUM line names rule id, file and line and a fix (remove the value, or allow it per DX-17).
- DX-10 (B2 says what it is doing). Before the early push, /ship prints the Greptile signal it used (config folder, `greptile.json`, or a Greptile comment within the last 90 days; older comments do not count), that it will push and open a draft now, and the wait cap; during the wait it prints progress. These lines apply whether B2 ends up default or opt-in (UC2).
- DX-11 (CEO-28 contract chosen). The classifier recognizes both `[P0]`-`[P3]` tags and severity words (`critical`, `high` blocking; `medium`, `low` non-blocking); a review with neither tags, severity words nor an explicit no-findings statement is `unverified`, never `clean`. The behavior is documented in `docs/troubleshooting.md` next to the gate outcomes.
- DX-12 (documentation touchpoints). The PR updates: CHANGELOG sections per symptom with copy-paste recovery ("If /autoplan denied every reviewer on Claude Code 2.1.29x", "If the pre-push hook warned on your own email", "If artifacts sync stopped pushing"); the guard troubleshooting page (DX-1); a README troubleshooting entry pointing at doctor; `gstack-brain-sync` usage (held, `--status` `held`, skip and unskip); the bug-report issue template; the browse cookbook (CEO-10); `gstack-post` usage; `docs/troubleshooting.md` (probe, classifier).
- DX-13 (no-op never prompts). The CEO-5/CEO-24 PTY runs assert that `: autoplan-published <phase>` runs without a permission prompt in the foreground session and, when driven, the `--bg` session.
- DX-14 (guard log bounded). `autoplan-guard.jsonl` keeps the last 1,000 lines (older lines are dropped on write); a free test covers the trim.
- DX-15 (Windows coverage of new helpers). `gstack-post`, `gstack-doctor` and the probe subcommands are added to the curated Windows free subset, or the PR names each one as not supported on native Windows yet.
- DX-16 (recovery TTHW measured). The CEO-24 foreground PTY run records the upgrade duration and the time from `/autoplan` invocation to Phase 1 entry; the PR reports them against the Competitive target (2-5 minutes for upgrade plus Phase 1 entry).
- DX-17 (pre-push email allowlist, taste). `git config --add gstack.redact.allowEmail <address>` allows that address for MEDIUM `pii.email` findings only; it never affects HIGH findings or other rules, and the MEDIUM fix line names it. Paired controls: an allowed address does not flag, a different address still flags, and a HIGH secret next to an allowed address still blocks.
- DX-18 (B3 compatibility window, taste). Sourcing stays supported for at least one release and at least 14 days, whichever is later; the CHANGELOG names the release that removes it, and the deprecation line (DX-7) appears from the first release.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- ENG-1 (background dispatch keeps the invocation armed). An `end_turn` while a reviewer `Agent` dispatched by this invocation has no completion record does not end the invocation, and a typed user turn during that window does not disarm the guard. Replay fixtures: background dispatch, `end_turn`, typed turn, next phase entry still requires the previous report. CEO-13's canary asserts the completion-notification record's `promptSource` and `isMeta` on the latest release, and the CEO-24 PTY session sends one typed message while a reviewer runs.
- ENG-2 (payload-path preconditions). The payload path runs only when every journaled `tool_use` has its result, except siblings with the last journaled `messageId`. When the newest journaled record is older than the assistant message before the current call (lag of more than one message), the hook waits up to 2 seconds for that record, then denies with a named journal-lag cause and the supported fallback. The same publish-separately cause seen twice in one invocation switches to the fallback text instead of repeating the instruction.
- ENG-3 (one batch rule on both paths; replaces CEO-1's payload-only sibling clause). Guarded calls in the same assistant message that target the same phase are one batch on the journal path and the payload path; a call targeting another phase still denies. Tests: fully flushed, partially flushed and missing-current batches, result-order permutations, and cross-phase negative controls.
- ENG-4 (dedup witnesses survive the window). The pass-one index records each `Read` tool_use's `file_path`, `offset` and `limit`; when a candidate Read's result is Claude Code's "file unchanged since your last Read" reply, the cited earlier record is loaded into pass two even if it predates the window. Fixture: two /autoplan runs in one session where the second driver Read is a dedup reply.
- ENG-5 (retained data and cost are bounded). Pass two keeps full content only for the record classes the evaluation reads: Bash results of init and checkpoint uses, results of candidate Reads, assistant text after the close Read, and mutation uses on the active plan; everything else stays index-only. Evaluation state is indexed by tool id and order, so no per-tool rescans. Retained data has a named bound; exceeding it is a hard denial naming an oversized invocation with the supported fallback. The 120 MiB acceptance journal puts most bytes inside the invocation window, and a second benchmark uses a large current invocation of many small records. CEO-25's spike compares the full rescan with a pass-one index cache under the state root (keyed by device, inode, scanned size and a hash of the last 64 KiB before the cached offset); a backward tail read cannot prove `competing_root` or `cycle`, so it is not the comparison. The cache is adopted only if the full rescan misses CEO-2's 1 s budget (taste).
- ENG-6 (long-session observer; amends CEO-15). CEO-15's case observes the outcome through the CEO-12 guard decision log (decision path and allow for the Phase 1 entry), not the 32 MiB PTY counting reader, and a free test proves that observer on the oversized fixture before the paid run. Padding records pass the ownership checks (session id, cwd, uuid chain, before a real `compact_boundary`), and the case asserts the decision path and reason code.
- ENG-7 (A4 transactions; replaces CEO-17's lock clause and narrows CEO-27). (a) Every gstack writer to `$GSTACK_HOME` git state (the drain, the skill-start merge, `gstack-artifacts-init`, `gstack-brain-restore`, `gstack-gbrain-source-wireup`) takes the same drain lock; a stale `.git/index.lock` is removed only while this process holds that lock and the index lock is older than 10 minutes, otherwise the drain reports the obstruction and keeps the queue. (b) Coupled groups come from an explicit map in code, starting with `decisions.jsonl` and its active snapshot; the drain expands selection to the whole group and stages a consistent generation (snapshot matching the log it was built from, checked before staging); unlisted paths are independent. (c) A failed `git commit` is distinguished from a verified empty staged diff (`git diff --cached --quiet`); any other failure keeps the queue and writes status `error`. (d) Scanner hits are attributed by splitting one staged diff on its `diff --git` headers in the existing Python block, not by one git process per path. Tests: an old index lock while another writer holds the drain lock is left alone; clean update of a group; a concurrent writer; a rejecting commit hook; a commit failure after staging; 1,000 queued paths in one scanner pass.
- ENG-8 (A3 line mapping and history scope; amends CEO-7). Collection and chunking keep commit, path and source-line mappings from hunk headers, so each MEDIUM line points at the real file line; findings only in historical commits name the commit. For `url` and `unknown` push targets, `repoPublicEmails` uses only the remote sha's history (when present locally) and the pushed commits, never all remotes. Author and committer emails are read raw and mailmapped (`%ae %aE %ce %cE`). Suppressing third-party emails that appear in the pushed commits is documented as accepted (they become public with the push). Tests: separated hunks, a chunk boundary, content removed before the pushed tip, and an email present only in another remote's history still flags.
- ENG-9 (`gstack-post` confirmation and argument safety; replaces DX-6's rule-id confirmation). On exit 2 the helper prints a confirmation token: a digest of the exact bytes, destination, operation and findings; `--confirm <token>` posts only those bytes, which the helper reads once and sends as scanned. Values go to `gh`/`glab` in `--flag=<value>` form or after `--`, and `<target>` must be a number or a same-host URL. Tests: replacing one flagged email with another (same rule ids and lines) needs a new token; a title of `--repo evil/x` is posted as text.
- ENG-10 (classifier precision; refines DX-11). Severity words count only in label position (`Severity: High`, a leading `High:`, `**High**`, `High —` or a table cell), not inside words like "high-level". A panel of stored real Codex outputs keeps its current verdicts, and the three outputs from this /autoplan run are added as fixtures (CEO, DX: severity words without tags; eng: `[P1]` tags).
- ENG-11 (canary supply chain and latency). `autoplan-schema-canary` installs the latest Claude Code with `npm install --ignore-scripts`, runs `npm audit signatures` before use, uses a budget-capped key, and runs in a job without write tokens. Its alert latency is stated as at most one day after a release (daily run, red in the periodic report), replacing "within a week".
- ENG-12 (probe names and timeout supervisor). DX-7's subcommand names govern; CEO-9's contract maps onto them (`check-auth`, `show-sandbox`, `run-with-timeout`). `run-with-timeout` supervises the command with the existing gtimeout, timeout, then watchdog chain (not exec) and returns 124 on timeout. Tests: stdin passthrough and exit 124 on both the coreutils and the bash-watchdog branch.
- ENG-13 (attention-line paths). Attention lines never include artifact or status-message paths; the absolute install-root helper path from DX-2 is allowed, and the no-status-text test allows it.
- ENG-14 (unknown Agent key). A reviewer dispatch with a key outside the allowlist is denied with its own reason code and the hand-run fallback, and CEO-12's log records the unknown key names, never values.
- ENG-15 (guard log writes; refines DX-14). Lines are append-only and carry a `schema` field; trimming to the last 1,000 lines happens through a temporary file and rename only when the file exceeds 256 KiB, and losing a concurrent trim race is tolerated. Doctor's reason-code row filters on the schema.
- ENG-16 (B1 bounds). The below-cwd checkpoint scan reads at most the 200 newest checkpoints and, from `$HOME`, lists only projects under the cwd by recency. Generic titles (`wip`, `checkpoint`, `save`, `notes`, `todo`) never match on title alone; they need the ticket token.
- ENG-17 (guard module layout). Reason codes, denial text and anchors live in one module beside the hook (single source for DX-1's anchor test), the payload evaluation is its own function, and `autoplan/bin/phase-publication-hook.ts` stays under the 800-line owner-module limit.
- ENG-18 (live-run scope, taste; amends CEO-24). The automated paid PTY case uses a hermetic minimal plan and covers Phase 1 entry plus one phase transition within the ~10-minute eval budget (rule kind, one trial). The every-transition run from CEO-24 is one recorded manual PTY session on 2.1.292 attached to the PR.
- ENG-19 (pin-bump reds, taste). PTY or gate reds on the 2.1.292 pin that are unrelated to /autoplan are repaired in this wave (one repair round each, no retries or lowered thresholds); a case still red after that round is reported as a named red through the #3059 measure loop, and whether it holds the merge is Garry's call at ship time.
- ENG-20 (B2 abort path). If /ship stops after opening the early PR, it leaves the draft open with one comment saying /ship stopped and why; it never closes or force-pushes it. If UC2 keeps B2 on by default, the early push on a public repo asks once for consent.
- ENG-21 (image tag binding). The pin bump runs `test/ci-image-tag-binding.test.ts` and updates any workflow image reference it requires.
<!-- /autoplan-accepted:eng -->
## Review record

### Autoplan run log (2026-10-07, base `db74567`, branch head `74cb0ca`)

- Phase 0: SOURCE_PLAN = ACTIVE_PLAN = this file; restore point `/home/user/.gstack/projects/garrytan-gstack/garrytan-followup-wave-oct7-autoplan-restore-20261007-144939.md`. Scope check on input sha256 `d1c1884a…c6ac`: 22 term matches (REST 1, command 4, argument 3, shell 2, Claude Code 9, agent 3), `dxRequired: true` by terms, and `--developer-tool` also applies (gstack is installed and built on by developers). UI scope: none (no view/rendering terms), so Phase 2 (design) is skipped.
- Phase 0.5: `CODEX_MODE: ready`, `CODEX_MODEL: gpt-6-astra` (config.toml). Codex CLI 0.160.1.
- Preamble prompts auto-handled without changing user state: the upgrade offer (installed 1.91.29.0, available 1.91.33.0) was not applied so the review skills stay fixed for this run; the telemetry prompt was not answered (telemetry stays off; never enabled on the user's behalf); `cross_project_learnings` is unset and was left unchanged (project learnings: 0).
- Host note: this run is Capy, not Claude Code. Agent dispatches are Capy subagents given the snapshot's `nativeDispatchPrompt` verbatim; the autoplan PreToolUse publication hook is not enforced here.
- CEO methodology `/home/user/.gstack/projects/garrytan-gstack/autoplan-ceo-methodology-VazWyP/methodology.md` (2484 lines, sha256 `ae2f7e72…aa17`) read through EOF in ranges 1-516, 517-916, 917-1316, 1317-1716, 1717-2116, 2117-2484. Skip-listed sections (preamble, AskUserQuestion format, outside voice, report/dashboard) loaded only.

### Phase 1 CEO review: Step 0

**System audit.** Branch carries one commit over main (this plan). No stashes. Most-touched files in 30 days are release files, `test/helpers/touchfiles-data.ts`, `plan-eng-review/sections/review-sections.md` and `TODOS.md`. TODOS.md "P1-P3: Oct 6 fix-wave follow-ups" is the source of A2, B2, B3, B4 and B5; this plan touches all eight entries in that block and leaves the /cso Windows transport (#3028) deferred.

**Retrospective (recurring problem area).** The /autoplan publication guard has produced a severe user-facing break roughly weekly: #2968, #2977, #2986, #3006, #3007, #3009 (v1.91.13.0 wave), #3050 (Oct 6), and now #3062. Every one came from the guard depending on undocumented Claude Code journal behavior (root shapes, flush timing, schema parsing, size). That is an architectural concern, not a series of bugs: the plan fixes this round, but only an early-warning lane on the Claude Code users actually run (X4 below) changes the pattern. The Oct 6 review also rejected raising the 32 MiB cap ("moves the same cliff"), which this plan respects by streaming instead.

**Taste calibration.** Good references: `lib/claude-public-transcript.ts` `readOwnedClaudePublicTranscript` (typed reasons, stable-read checks, one test seam that can only lower the cap) and `bin/gstack-redact-prepush` (fail-closed parse, honest "could not scan" vs "found a secret" messages). Patterns to avoid: `bin/gstack-brain-sync`'s `git add ... 2>/dev/null || true` and `reset ... || true` (swallowed failures, the root of PR #3055's stuck index lock) and its private Python secret scanner, a weaker copy of `lib/redact-patterns.ts`.

**Landscape check.** Aside is not available on this Linux host; WebSearch was used. Findings: (1) Claude Code's hooks reference states `transcript_path` "is written asynchronously and may lag the in-memory conversation"; anthropics/claude-code#100051 shows sessions where the assistant message carrying the `tool_use` is written only together with the tool's result, so no poll bound helps, and #61983/#87223 show that text written earlier in the same assistant message is invisible to PreToolUse too. (2) Greptile does not review draft PRs by default (`triggerOnDrafts: false`; `autoReview` default `["open"]`); a draft is reviewed only on "ready for review" or an `@greptileai` comment. Layer 3 synthesis: a guard on a lagging journal can only ever see *earlier* messages, so it must require that whatever it checks (the phase report) was flushed by an earlier tool result, not merely written earlier in the same message.

**Live probes (this review).**
- Claude Code 2.1.292 is the npm latest; `claude --help` on 2.1.292 lists `--bg, --background` and `claude attach <id>`. The CI pin is 2.1.284 (`.github/docker/Dockerfile.ci:138`), and its comment requires a pin bump to run "the PTY gate against the new TUI".
- `autoplan/bin/phase-publication-hook.ts:38` normalizes only `file_path`; `:428` deep-equals journal vs payload input; `:587` 2-second poll; `:482-483` the existing pending-Read path deliberately refuses to establish a new phase from a payload ("it cannot establish a phase, a publication, or a synthetic current use", `:479-481`). Cause B reverses that rule, so the plan must say why it is now safe.
- `autoplan/sections/phase-close.md.tmpl:40-42` makes the phase report "the next operation before any next-phase tool call" in the same turn, so the report text and the next phase's guarded driver `Read` commonly share one assistant message.
- `lib/claude-public-transcript.ts:74` caps at 32 MiB; `:570-577` treats any append during the read as `changing` (retry). Timing on a synthetic 120 MiB journal (4 vCPU Linux, cap lifted in a scratch copy): the current reader returns `ready` in 440-500 ms with ~684 MiB peak RSS; plain read plus `JSON.parse` of every line is ~170 ms at ~248 MiB. Memory and the append window are the real limits, not parse time.
- `bin/gstack-redact-prepush:521` passes only `repoVisibility` and `sourcePath`; `lib/redact-engine.ts:331-332` already honors `selfEmail` and `repoPublicEmails`. The remote sha is all zeros for a new branch, the most common push.
- `bin/gstack-brain-sync:727,735` swallow `git add`/`git reset` failures; `:131-136` prints the first 30 characters of a matched secret into the status message; `gstack-brain-restore`, `gstack-artifacts-init` and `gstack-gbrain-source-wireup` run git in `$GSTACK_HOME` without the drain lock.
- `scripts/resolvers/aside.ts:118-131` holds the browser rules rendered into about 100 generated skill files; rule 1 forbids touching tabs the user did not name; rule 6 recommends an early `return`.
- `gh pr view 1743`: author @habassa5, but CHANGELOG v1.64.0.0 (line 3156) credits it to @punksterlabs, the same mapping slip #3054 reports for #1822.

**0A Premise challenge.** The real problem is three guards that make users route around gstack: /autoplan cannot enter a phase on current Claude Code, the pre-push hook warns on every push in repos that commit author emails, and the artifacts sync silently stops for weeks. Do-nothing cost: /autoplan is unusable on default Claude Code for every user who upgrades (P1), and users learn to ignore or bypass the other two guards. The plan targets the pain directly. Premises checked:
1. "Cause B fix: evaluate the current call from the payload" is valid for calls inside a phase, but it does not fix phase transitions in lagging sessions: the phase report is written in the same assistant message as the next guarded `Read`, so it is invisible exactly when the `tool_use` is (claude-code#100051). The guard would then deny with "Publish the filled Phase N report", the model republishes in the same shape, and the loop repeats. Accepted fix below (CEO-1).
2. "A session journal over 100 MiB no longer stops it" needs more than streaming: any append during a long read is `changing`, a retry denial, and appends are frequent in long sessions. Accepted fix (CEO-2).
3. P1's sentence "Every denial that remains names a cause that retrying cannot fix" is stricter than the code can honor: "A prior phase-entry tool is still pending" (`:478`) is a real transient where waiting for the result does succeed. Kept as written; CEO-3 makes it testable by inventory and the wording question goes to the gate as a taste choice.
4. "A3 reads the remote's history at `<remote sha>`" misses new-branch pushes (zero sha) and unknown remote tips. Accepted fix (CEO-7, Section 3).
5. "B2: open a draft PR and wait for Greptile" cannot work on default Greptile settings (drafts are not auto-reviewed). Accepted fix (CEO-8).
6. "B3: sourcing keeps working for one release ... the zsh self-locate code is no longer needed" contradicts itself: the sourced mode still runs from zsh during that release. Accepted fix (CEO-9).
7. "B6: list the open tabs and attach to a signed-in one ... don't ask the user again" drops rule 1's consent (#3063 itself asks to confirm the tab with the user once). Accepted fix (CEO-10).

**0B Existing code leverage.**

| Sub-problem | Existing code | Reuse |
|---|---|---|
| A1 identity compare | `nativeToolInput`, `consumption()`, pending-Read path in `phase-publication-hook.ts` | Extend; the pending-Read path becomes the general payload path |
| A1 PTY reproduction | `test/helpers/pty/launch.ts`, `session.ts`, `claude-pty-runner.ts` | Extend with a `--bg` + `claude attach` launch |
| A1 journal canary | `test/skill-e2e-autoplan-journal-drift.test.ts` | Reuse on 2.1.292; add a latest-release run (X4) |
| A2 bounded read | `readOwnedClaudePublicTranscript`, `ownedCausalLines`, `transcriptReadLimit()` seam | Refactor the read loop; keep causal ordering and reasons |
| A3 email exemptions | `ScanOptions.selfEmail`/`repoPublicEmails`, `emailAllowed()`; hook's `pushTarget()`, `remotesExclusionArgs()` | Reuse; no engine change |
| A4 per-path hold | `compute_paths_to_stage` retained set, `write_status`, `queue_summary`, skill-start `ARTIFACTS_SYNC` block | Extend |
| B1 checkpoint scan | `gstack-slug --classify-checkpoints`, context-restore Step 1 ordering | Extend |
| B2 Greptile | `ship/sections/greptile.md.tmpl`, `review/greptile-triage.md` | Extend timing only |
| B3 probe | `bin/gstack-codex-probe` functions, `scripts/resolvers/outside-voice.ts` | Wrap functions as subcommands |
| B4 posting | `FREE_TEXT_DIR` file rule, `bin/gstack-redact`, ship `pr-body` scan | New thin helper that reuses the redact CLI |
| B5 readiness | `./setup --status`, `gstack-codex-probe`, skill-start hook check | Reuse each probe; no new probe logic |
| B6/B7 | `scripts/resolvers/aside.ts` rules and cookbook; CHANGELOG | Edit in place |

**0C Dream state.**
```
  CURRENT STATE                      THIS PLAN                              12-MONTH IDEAL
  Guard breaks on each Claude  --->  Guard tolerates schema strips,   --->  Guard verified on the Claude Code users
  Code change; CI pinned to          flush lag and 100+ MiB journals;       run before they run it; every guard
  an old CLI; pre-push and           pin moved to 2.1.292; pre-push         message names its cause and fix; one
  sync guards cry wolf or            and sync guards precise; one           write path for GitHub text; readiness
  fail silently                      posting helper; doctor                 visible before any skill starts
```
The plan moves toward the ideal on every axis; the gap it leaves is early warning, which X4 closes for journal shape (not for flush timing, which needs an interactive session).

**0D Approach.** One plan-level approach choice was needed for A1/A2.
- A) Targeted fixes as written, plus the corrections in CEO-1..CEO-3 (keeps exact checks; publication still required). Effort M, risk medium.
- B) Deny only on proof: every unverifiable state (lag, `changing`, unknown shape) becomes an advisory allow like `unverifiedEntry`. Effort S, risk high: enforcement disappears whenever Claude Code lags, which on #100051 sessions is always.
- C) Replace journal evidence with a different publication proof (for example the snapshot tool recording a hash of the published report). Effort L, risk high: the published text is only observable in the journal, so C moves rather than removes the dependency.
Auto-decided A (P1 completeness keeps the guarantee; P5). For A2: streaming bounded read (plan) over raising the cap with a full read (Oct 6 consensus: a cap raise only moves the cliff; measured peak RSS is 5.7x journal size).

**0E Mode.** Override: SELECTIVE EXPANSION. (The skill's file-count rule would recommend SCOPE REDUCTION at well over 15 changed files; the user's one-PR rule and /autoplan's override govern.) Mode: SELECTIVE EXPANSION; approved decisions: CEO-D1 (approach A). Hardens the current scope and offers each cherry-pick individually.

**0F/0G Cherry-picks and HOLD checks.**
HOLD checks: complexity is far over 8 files, but each item is independent and the user wants one PR with separate commits (kept). Minimum change for each promise is the item as written plus the corrections above. Tier 2 deferral per item: all kept (P1; reducing scope on a complete plan is never auto-chosen).
10x: one guard contract (payload-backed current call, flush-safe publication, append-tolerant reads, no unexplained retries) plus a canary on the latest Claude Code turns the guard from a weekly fire into a monitored dependency. Platform potential: `gstack-post` becomes the single, redaction-scanned write path for every skill's GitHub/GitLab text.

| # | Proposal | Effort | Decision | Reasoning |
|---|---|---|---|---|
| X1 | B7 also corrects #1743's credit to @habassa5 (CHANGELOG v1.64.0.0) | S | ACCEPTED | Same entry, same slip; P2 |
| X2 | A2 latency and peak memory also measured on macOS through the existing macOS CI runner | S | ACCEPTED | Restores the TODOS.md acceptance ("macOS and Linux"); P1 |
| X3 | Every guard denial appends one content-free line (code, Claude Code version, decision kind) to `analytics/autoplan-guard.jsonl` | S | ACCEPTED | Same file and log as `unverifiedEntry`; user reports carry the cause; P2 |
| X4 | The journal-drift canary also runs periodically on the latest Claude Code release, not only the pin | S | ACCEPTED | #3062's root cause was "CI never sees it"; 2 files; P1/P2 |
| X5 | Pre-push MEDIUM summary names rule id, file and line (never the matched value) | S | ACCEPTED | Same output line A3 already changes; P2 |
| X6 | `gstack-brain-sync --status` lists held paths with the two fixes (`--skip-file`, edit) | S | ACCEPTED | A4's attention line points here; P2 |
| X7 | `gstack-doctor` checks a named session journal with the guard's reader | M | DEFERRED | Doctor runs outside a session; design unclear; P3 |
| X8 | Replace brain-sync's Python secret scanner with `lib/redact-engine.ts` | L | DEFERRED | Cross-language rewrite outside the item; P3 |
| X9 | Persist a parsed-prefix cache for journal reads | M | SKIPPED | 120 MiB reads take ~0.5 s; memory is the limit and streaming fixes it; a cache adds a forgeable trust input; P5 |
| X10 | Autoplan preflight warns on `--bg`/fork-gate sessions | S | SKIPPED | Superseded once Cause B works in `--bg`; P4 |

**0I Temporal interrogation** (human team / CC+gstack).
- Hour 1 (foundations): the implementer needs claude-code#100051's flush model, the existing pending-Read rule (`:479-483`) and the phase-close ordering. (~4 h human / ~20 min CC.)
- Hours 2-3 (core logic): ambiguities are which earlier records count as "consistent" for a synthesized call, the per-record bound for A2, and how A4 attributes scanner hits to paths (the scanner reports the first match per pattern with no path today). (~2 days / ~2 h.)
- Hours 4-5 (integration): surprises are the `--bg` session needing `claude attach` under the PTY harness, Greptile ignoring drafts, and the pin bump moving every PTY case's TUI. (~2 days / ~2 h.)
- Hour 6+ (polish/tests): they will wish they had the reporters' timelines as replay fixtures from day one, a macOS timing run, and the prompt-size checks for the aside rules that render into ~100 files. (~2 days / ~3 h.)
Feasibility blockers: none that block the plan; the `--bg` PTY reproduction may prove infeasible, which CEO-5 handles by recording it unverified instead of claiming it.

**0H CEO plan and Spec Review Loop.** CEO summary: `/home/user/.gstack/projects/garrytan-gstack/ceo-plans/2026-10-07-followup-wave-oct7.md`. Three reviewer launches (Capy subagents, both saved inputs each time): review 1 scored 6/10 (FAIL, 32 issues), review 2 7/10 (FAIL, 18; Scope passed), review 3 7/10 (FAIL, 19). Each round's issues were resolved by revising the CEO obligations and exact baseline edits; review 3's fixes landed after the three-launch cap and are not reviewer-confirmed. Metrics appended to `analytics/spec-review.jsonl` (iterations 3, found 69, reviewer-confirmed fixed 0, remaining 19, score 7). Document approval auto-decided A (both documents reflect the exact decisions). 0I is recorded above.

**CEO accepted obligations** (Step 0; later CEO sections add to this same block).

<!-- autoplan-accepted:ceo -->
- CEO-1 (A1 Cause B, payload-backed current call and flush-safe publication). The payload path covers both guarded tools, `Read` and `Agent`, and replaces the pending-Read rule that refuses to establish a phase from the hook payload. On the first complete read of a `ready` journal that lacks the current `tool_use_id`, with every journaled record passing the existing order, identity and ownership checks, the guard evaluates the call from the payload (`tool_name`, `tool_use_id`, `tool_input`) placed after the last journaled record, which anchors ancestry. It does not wait out the 2-second window first (claude-code#100051: in lagging sessions the record arrives only with the tool result); the window remains only for a journal that does not exist yet and for the unrecognized-shape double read. A new phase may be established only if the previous phase's report is present in journaled records.
  Agent input binding on both paths: a constant in the hook lists the allowed Agent keys (`prompt`, `description`, `subagent_type`, `run_in_background`), so no snapshot manifest changes and snapshots made before the upgrade keep working; `prompt` must equal `nativeDispatchPrompt` (as `consumption()` checks today), `subagent_type` must be absent or `general-purpose`, and any other key, including `model`, is denied. On the journal path the journal-versus-payload comparison stays exact apart from `run_in_background` (Cause A), so a changed `description` is still caught there; on the payload path there is no second copy, so the `description` control applies to the journal path only.
  Batched calls: on the payload path the hook payload has no `messageId`, so the last journaled assistant `messageId` is treated as possibly the current call's message. Pending journaled siblings count as the same batch only if they carry that `messageId` and target the same phase; then they are not "a prior phase-entry tool still pending". A sibling that targets a different phase still denies.
  Allowlist evidence: the full schema-parsed Agent payload key set on 2.1.292 (default settings) is captured as a fixture before the allowlist is fixed, and CEO-13's canary asserts the payload keys stay inside it.
  Publication flush: because text in the same assistant message as a guarded call is invisible to the hook in lagging sessions, a phase transition on either path counts only a report that a later journaled record follows, either a tool result or a record with a different `messageId`; a report in the last journaled assistant message with nothing after it does not count on the payload path. The outcome therefore never depends on flush timing. Phase-close step 6 publishes the phase report in a message whose only tool call is the no-op Bash `: autoplan-published <phase>` (no output, unguarded), and step 7 makes the next guarded `Read` or `Agent` (the next phase driver, or the Phase 4 tasks aggregator after any skip messages) go in a later message. When a payload-path phase entry finds no journaled report, the denial names that cause and says to publish the report in its own message with that no-op call; it never says "retry".
  Tests: replay fixtures shaped like the #3062 timelines (the `--bg` Read batch at offsets 1, 601 and 1201, and a lone foreground `Agent` dispatch) are denied on main and allowed after the fix; a phase transition whose report shares a message with the guarded `Read` on a lagging journal gets the publish-separately denial, the same report in the same message is denied on a fully flushed journal too, a partial flush (the current message's text journaled, its `tool_use` not) is denied, and the transition after the no-op call is allowed; a same-phase sibling batch is allowed and a cross-phase sibling is denied. Negative controls stay denied: a changed prompt on either path, an added `model` on either path, a changed `description` on the journal path, and a payload-path call that would enter a new phase without a journaled report.
- CEO-2 (A2 bounded, append-tolerant read). Approach: the hook gets its own two-pass owned reader. Pass one streams the file up to the size observed at open, ending at the last complete line, and keeps a small index per record (uuid, parent uuid, record kind, byte offset and length). Ownership, ancestry and order checks run on index metadata: uuid, parent and logical parent uuid, type and subtype, SessionStart attachment flag, `isSidechain`, `agentId`, cwd, timestamp validity, message role, `messageId`, the class of each user turn (typed, `/autoplan` slash, other), each `tool_use` name and id, and the command string of each Bash `tool_use` (so `initArguments` can find literal inits). Pass two loads full records only for the invocation window: from the latest human `user_turn` at or before the first non-reused literal init of the currently bound invocation chain (a `reused:true` init keeps the earlier binding, as `invocation()` does today), so runs started by a typed request or the Skill tool still bind init and a re-arm keeps an outstanding publication. A flag records whether an `end_turn` precedes that turn for `disarmed()`. The existing tests "a real same-restore init re-arms without erasing an outstanding publication" and "rearm excludes disarmed future Reads" stay as controls. Per-record event extraction moves into one shared module, `lib/claude-journal-records.ts`, called by both this reader and `readPlanCountTranscript`, so the two cannot drift. `readPlanCountTranscript` and its batch callers (tests and PTY runners) keep their current reader and 32 MiB cap. Appends after open never fail the read; the same device and inode and no shrink are required. Within one hook invocation, a second read compares the sha256 of bytes [0, first size) with the first read; a mismatch is a hard denial naming a rewritten journal plus the supported fallback. Rewrites between hook invocations are not detected (accepted limit, documented). The unverified-entry advisory's two-read stability check uses that same prefix hash, and the diagnostic pass is streamed so memory stays bounded. Per-record bound: 32 MiB (the old whole-file cap, so no journal readable today becomes unreadable), a named constant documented in `docs/autoplan-guard-troubleshooting.md`; any single record over it yields `too_large`.
  Acceptance (recorded in the PR, not a CI timing gate): `scripts/measure-journal-read.ts` builds a 120 MiB journal whose record count and size mix match the reported journals (not only a few large records; the review's 440-500 ms figure came from the current full reader on a 5.7k-record synthetic), appends during the read, and measures one read plus evaluation. On a GitHub-hosted `ubuntu-latest` runner (4 vCPU) it must take at most 1 s with peak RSS at or under 256 MiB; a parse-and-index spike on that journal runs before the reader design is committed; the free suite asserts the decision and the bounded index size through the shrink seam, plus a fixture for a Skill-tool start with no slash turn. A run that misses either threshold holds the A2 commit (Tier 1 holds the PR) until it is fixed or the user grants an explicit exception.
- CEO-3 (P1 denial inventory and codes). Every `fail()` site in `autoplan/bin/phase-publication-hook.ts` gets a stable reason code, and the PR lists each with its disposition: removed by A1/A2; a non-transient cause with the supported fallback; a named corrective action the user or model must take first (for example "restore this installation", "run init", "publish the report"); or a named transient that says what to wait for (today "a prior phase-entry tool is still pending" and "an active-plan mutation is pending"). A free test fails on any denial text that advises a retry without naming its corrective action or transient condition.
- CEO-4 (pin bump validation). Moving `.github/docker/Dockerfile.ci` to Claude Code 2.1.292 runs the full gate tier (`bun run eval:bg:gate`) on the new pin, as the Dockerfile's own comment requires ("runs the PTY gate against the new TUI"), in addition to the autoplan paid cases and `autoplan-journal-drift`. The pin comment records why 2.1.292 was chosen, and `test/ci-image-cli-pin.test.ts` passes.
- CEO-5 (`--bg` reproduction honesty). The PTY reproductions run with default settings (no `CLAUDE_CODE_FORK_SUBAGENT` override, clean config). One starts a session with `claude --bg` and drives it through `claude attach <id>`. If the harness cannot drive an attached session, the PR and release notes state that P1's `--bg` case was verified only by replay fixtures, and skipped item X10 (a `--bg` preflight warning) is reopened as a TODOS.md entry. The foreground session also prints whether `$CLAUDE_PROJECT_DIR` is set inside a Bash tool call, recorded in the PR for CEO-22.
- CEO-6 (macOS measurement). `scripts/measure-journal-read.ts` runs once through a `workflow_dispatch` job on `ubuntu-latest` and `macos-latest` on the A2 branch (not on every PR); the macOS numbers are recorded in the PR next to the Linux numbers and do not gate.
- CEO-7 (A3 remote history for new branches). When the pushed remote sha is all zeros or not present locally, `repoPublicEmails` comes from the push remote's tracking refs (`git log --format='%ae%n%ce' --remotes=<remote>`) plus the pushed commits. Every history read, including the normal `<remote sha>` path, is bounded to 50,000 commits and 5 seconds; any failure or overrun passes nothing (today's behavior). The MEDIUM summary names each finding's rule id, file and line, never the matched value.
- CEO-8 (B2 Greptile lifecycle). Greptile is detected by `greptile.json` or a `.greptile/` folder (the folder takes precedence), or past Greptile comments. When /ship opens the early PR as a draft and the effective config does not set `triggerOnDrafts: true`, /ship posts one `@greptileai` comment to start the review. /ship marks the PR ready at its existing PR step unless the user asked for a draft; the review Greptile starts on "ready" is expected, is not awaited, and its comments are handled by the next /ship or /land-and-deploy Greptile pass, so no extra comment is posted to trigger it. Completion signal: /ship polls every 30 seconds for Greptile's check run or summary comment on the early PR's head SHA, for at most 10 minutes; only a completed check or summary counts as a finished review (zero comments allowed), and a timeout takes the existing unavailable path, never a claim of zero comments. The early draft carries the provisional title and a body saying /ship opened it early for review and will update it; the existing PR step edits that PR instead of creating one. Comments on an earlier head are triaged against the final diff. The trigger comment goes through `gstack-post` when B4 ships; otherwise through `gh pr comment --body-file` with a file written by the host's file tool (the existing free-text rule). Without Greptile nothing changes. Tests: fixture repos with and without `triggerOnDrafts` and with a `.greptile/` folder assert whether the trigger comment is posted.
- CEO-9 (B3 every probe function has an executed form). Each of the ten probe functions generated skills call today gets a subcommand: `select-model`, `auth`, `sandbox-mode`, `sandbox-preflight`, `model-probe`, `version-check`, `first-use-notice`, `timeout` (execs the wrapped command and returns its exit code), `log-event` and `log-hang`. Contract (stdout `KEY: value` lines; human status lines stay on stderr as today; nothing is set in the caller): `select-model <exec|review>` prints `CODEX_SEL:` and `CODEX_SEL_KIND:`, keeps the `CODEX_MODEL:` stderr line, exits 0 or 1; `sandbox-mode` prints `CODEX_SANDBOX:`; `sandbox-preflight` exits 0 or non-zero with the reason on stderr; `model-probe <exec|review> --model <m> --kind <k>` prints `CODEX_PROBE_STATE:` and keeps today's exit codes (0, 2, 3, other); `auth` reports by exit code; `version-check` and `first-use-notice` print to stderr and exit 0; `timeout <secs> <cmd...>` execs the command and returns its exit code (124 on timeout); `log-event <event> [detail]` and `log-hang <skill> <n>` print nothing and exit 0. Generated blocks capture a value with `sed -n 's/^KEY: //p'`, so `CODEX_MODEL_CONFIG_FLAG` reads the captured model instead of `${_GSTACK_CODEX_SEL}`. Sourcing keeps working for one release for skills rendered before the upgrade; the zsh self-locate code stays while sourcing is supported and is removed in the same change that drops sourcing. The existing zsh sourcing test keeps passing during the compatibility release, and a free test runs each subcommand once from bash and zsh.
- CEO-10 (B6 consent kept). Attaching to a tab the agent did not open still requires the user to confirm that tab once (rule 1). The agent may show the user only tabs whose origin equals the target origin the user named (title and origin); the rest of `listBrowserTabs()` stays private. After a confirmed sign-in, a second sign-in wall means the session is bound to the tab or URL: the agent proposes attaching to the user's signed-in tab with that one confirmation instead of asking for another sign-in. Rule 6 no longer suggests an early `return`; key presses use `pg.locator(sel).press(key)`; an `[ok` result from a very short run with no `GSTACK_STEP_OK` is a script abort. Rule text stays short because it renders into about 100 generated skill files; the details go in the browse cookbook.
- CEO-11 (B7 second credit). In the v1.64.0.0 CHANGELOG entry, @punksterlabs is replaced by @Mike-E-Log for the extension token fix (#1822) and by @habassa5 for the polyfill `exited` promise (#1743). Commit history is not rewritten.
- CEO-12 (guard decision log). Every guarded decision, allow or deny, appends one content-free line to `<state root>/analytics/autoplan-guard.jsonl` with the decision, the CEO-3 reason code for a denial, the evaluation path (journal or payload), the Claude Code version and the disposition class, so denials have a denominator; a logging failure never changes the decision. A free test checks the line for one allow, one hard denial and one transient denial.
- CEO-13 (latest-release schema canary). A new periodic case `autoplan-schema-canary` (own test file, `touchfiles-data.ts` entry, periodic tier, rule kind) runs inside the CI image from `.github/workflows/evals-periodic.yml` on a daily schedule added for this case alone (existing `ANTHROPIC_API_KEY` secret, haiku, about $0.02 a run, about $0.60 a month); the weekly matrix is unchanged. It installs the latest published Claude Code into a temporary npm prefix (selected through `GSTACK_CLAUDE_BIN`), runs a headless session whose PreToolUse hook records the payload for one `Agent` and one `Read` call, and after the turn compares each payload with its journal record using the guard's own comparison (`nativeToolInput` is exported for it), asserts the payload keys stay inside CEO-1's allowlist, and asserts that the payload's key set equals the journal record's key set except for documented strips (today `run_in_background`) for both tools, so a schema strip like Cause A fails CI within a week of a release and reaches the existing periodic `report` job like any red case. The new case has no pin assertion; `autoplan-journal-drift` keeps its pin assertion unchanged. Flush timing is out of its reach (headless) and stays covered by CEO-5. A free fixture proves the comparison fails on an injected key strip. It is proven before merge by one manual dispatch on the PR branch and run again on merge day against the latest release, both linked in the PR.
- CEO-14 (sync status detail). `gstack-brain-sync --status` JSON gains a `held` array with each held path, the scanner rule name (never the matched text) and both fixes (`gstack-brain-sync --skip-file <path>`, or edit the content). A free test covers one held path.
- CEO-15 (P1 long-session end to end). One paid PTY case (rule kind, one trial, inside the ~10-minute eval budget) resumes a session whose journal has been padded past 100 MiB with records before a compact boundary (which Claude Code does not replay to the API) and enters /autoplan Phase 1 through the guard; its cost is estimated in the PR before it runs. If Claude Code cannot resume a padded journal, the PR says P1's long-session promise was verified only through the reader acceptance in CEO-2.
- CEO-16 (TODOS.md edits). The implementation PR removes each "Oct 6 fix-wave follow-ups" entry only when its item ships and meets that entry's acceptance (the bounded-read entry needs CEO-15 to pass end to end; otherwise it is reworded to the remaining gap); Tier 2 items that do not ship keep their entries. It keeps the /cso Windows transport entry, adds X7 and X8 with their deferral reasons, and adds X10 when CEO-5 reopens it.
- CEO-17 (A4 health signal and lock safety). Scanner holds: a drain that holds back flagged paths and pushes the rest writes the new status `held` (not `blocked`) with the held count; held records stay queued and are re-scanned on every drain until the content is clean or `--skip-file` names the path. Skill start shows an attention line whenever the status is `held` or `blocked`, and separately when no push happened for 24 hours while drainable records wait; scanner-held and privacy-held records never count as drainable. The drain writes a `drainable` count into the status file so skill start does not need the privacy classification. The `ARTIFACTS_SYNC:` attention line is fixed text plus a status code clamped to `ok`, `idle`, `held`, `blocked`, `push_failed` or `error` (anything else prints `unknown`), never the status message, file paths or scanner output (the status message can hold the first 30 characters of a matched secret). A stale `.git/index.lock` is removed only while this drain holds the drain lock and the index lock is older than 10 minutes, because `gstack-brain-restore`, `gstack-artifacts-init` and `gstack-gbrain-source-wireup` run git in `$GSTACK_HOME` without that lock. Per-path holds attribute scanner hits by scanning each staged path's diff. Tests: a held file reported at skill start while other files keep pushing, a held file cleared by editing and by `--skip-file`, a privacy-held queue without the alarm, a fresh index lock left alone, an old one cleared, and an attention line that contains no status text.
- CEO-18 (generation and prompt checks per template item). Every item that edits a template or resolver (A1 phase sections and phase-close, B2, B3, B4, B6, CEO-20, and CEO-17's `scripts/resolvers/preamble/generate-brain-sync-block.ts`, which tells the model to surface the new attention line to the user and continue) regenerates with `bun run gen:skill-docs` and `bun run gen:skill-docs --host codex`, and passes `test/parity-suite.test.ts`, the prompt-size checks and the golden fixtures before its paid eval.
- CEO-19 (B4 owns the redaction scan). `gstack-post` runs `gstack-redact` on the exact bytes it is about to send, with `--repo-visibility` from the caller's existing visibility detection and `--self-email` from `git config user.email`. It refuses on a HIGH finding with the rule names; on a MEDIUM finding (exit 2) it posts nothing and returns the findings so the caller asks its existing per-finding question before posting; and the callers it replaces (/ship's PR title and body scan in `ship/sections/pr-body.md.tmpl`, and the PR or issue write sites rendered from `scripts/resolvers/redact-doc.ts`) drop their separate scans. Tests: a HIGH secret in a body file is refused and nothing is posted; a MEDIUM finding posts nothing until the caller confirms; a clean body posts with argument-array `gh` invocation verified by a stub.
- CEO-20 (shared foreground note). Every site that requires `run_in_background: false` adopts the conditional wording `spec-review.ts:154` already uses ("if that field is available; omit it otherwise") plus the recovery for a background run: `FOREGROUND_DISPATCH_NOTE` in `scripts/resolvers/constants.ts`, `scripts/resolvers/design.ts` (two sites), `outside-voice-steps.ts` (three sites), `review-army.ts` (two sites), `spec-review.ts:61`, and the three templates that inline the literal (autoplan `ceo-phase`, `cso`, `design-shotgun`). The bounded-wait dispatch that sets `run_in_background: true` (`outside-voice-steps.ts:482`) is unchanged.
- CEO-21 (doctor spends nothing by default). `gstack-doctor` never runs the paid Codex model probe by default: it reports the cached result with its age, or "not probed", and runs the live probe only with `--live`.
- CEO-22 (B1 definitions). Case 2's task match is a worktree path below the main tree, equal normalized checkpoint titles (lowercased, whitespace collapsed, punctuation and a leading date removed), or the same ticket token (`#123` or `ABC-123`) in both checkpoints' titles or branch names. Case 1's pointer is a JSON file in the starting directory's bucket holding the checkpoint path, its bucket and `project_root`; the starting directory is `$CLAUDE_PROJECT_DIR` when set in the Bash tool environment (CEO-5 records whether it is), and when it is unset no pointer is written (the below-cwd scan still finds the checkpoint).
- CEO-23 (A3 independent fallbacks and B4 site scope). A3's two inputs fail independently: a failed `git config user.email` omits only `selfEmail`, and a failed or bounded-out history read omits only `repoPublicEmails`. B4's `gstack-post` covers the PR and issue sites; question tuning's `--summary-stdin` and the `docs/gbrain-write-surfaces.md` heredocs move to the agent-written file rule instead, since neither calls `gh` or `glab`.
- CEO-24 (PTY-first gate and live phase transitions). Before CEO-1's payload path is built, the foreground PTY reproduction (2.1.292, default settings) runs against main and records whether the lone guarded call's record is missing at hook time, confirming the flush mechanism the design assumes. After the fix, the PTY run drives /autoplan through every phase transition in the foreground, and through `claude attach` for `--bg` when CEO-5 can drive it, including one transition that uses the `: autoplan-published <phase>` no-op on a lagging session. For any promised mode that cannot be verified live, the PR narrows P1 for that mode and #3062 stays open for it.
- CEO-25 (tail-read spike). Before CEO-2's reader design is committed, a spike measures a backward read from end of file that stops at the invocation window start and the latest compact boundary, plus a head read for the root and SessionStart checks. The design that proves the same ownership, ancestry and order checks at lower cost is adopted, and the PR records why the other was rejected.
- CEO-26 (admission cutoff inside the one PR). The mandatory set is Tier 1, the CEO-4 pin bump and any runtime or harness repair they need. Tier 2 items are admitted only after the mandatory set is green; a Tier 2 item still red after one repair round is reverted as its own commit and moves to TODOS.md, and P3 is reported per item that shipped. The selected eval schedule and its cost estimate are written into the PR before Tier 2 is admitted.
- CEO-27 (A4 coupled artifacts and drain liveness). A held path holds its coupled group (artifacts that reference each other, such as a decision log and its active snapshot, as listed from the sync allowlist), so the remote never receives a partial generation. Acceptance restores onto a second `GSTACK_HOME` with a held dependency and checks the consumers read a consistent state. The drain writes `last_drain_at`; skill start alarms when it is older than 24 hours and the queue holds records, without trusting the drain's own counts. Tests: a held decision log holds its snapshot; the drain never running raises the alarm.
- CEO-28 (outside-review severity words). `lib/outside-review-result.ts` counts severity words (`critical`, `high`) as blocking findings in review-gate outputs, or every outside-voice prompt requests `[P0]`-`[P3]` tags and the classifier treats untagged findings as `unverified`, so a review that lists high-severity findings is never reported `VERDICT: clean`. A regression fixture uses the shape of this run's Codex CEO output (seven "High"/"Medium" findings classified `clean`, `FINDINGS: none` by the installed 1.91.29.0 classifier).
- CEO-29 (doctor triage rows). `gstack-doctor` also prints the Claude Code version, the size of the largest session journal for the current project, and the last five guard reason codes from `autoplan-guard.jsonl`; the bug-report issue template asks for its output.
- CEO-30 (upstream request). The PR links an anthropics/claude-code issue (new, or a comment on #100051) asking for the assistant `messageId` or a flushed-before-hook guarantee in the PreToolUse payload, the supported surface that would retire the payload heuristics.
- CEO-31 (contributor tests). Contributor code stays evidence and every fix is rewritten; contributors' regression tests are reused, adapted to the rewrite, when they pass review, and the PR says why any was not.
<!-- /autoplan-accepted:ceo -->

CEO baseline edits (exact replacements that fold CEO-1, CEO-2, CEO-4, CEO-6..CEO-11 into the item text they correct):

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"d1c1884afaae8e492b2da96a7a6ba933dfa6b5a257a1ee27c58b515d3fd6c6ac","replacements":[{"oldText":"and keep the stability checks (same file identity and size before and after).","newText":"and keep the identity checks (same device and inode, no shrink) on an append-tolerant prefix read (CEO-2)."},{"oldText":"are measured on Linux and recorded in the PR.","newText":"are measured on Linux and macOS (CEO-6) and recorded in the PR."},{"oldText":"from the remote's history (`git log --format='%ae%n%ce' <remote sha>`)","newText":"from the remote's history (`git log --format='%ae%n%ce' <remote sha>`, or the push remote's tracking refs for a new branch or unknown remote tip, CEO-7)"},{"oldText":"(draft unless the user asked otherwise)","newText":"(draft unless the user asked otherwise; a draft gets one `@greptileai` trigger comment when Greptile skips drafts, CEO-8)"},{"oldText":"The zsh self-locate code is no longer needed in the probe.","newText":"The zsh self-locate code goes in the same change that drops sourcing (CEO-9)."},{"oldText":"Before opening a tab for a target, list the open tabs and attach to a signed-in one.","newText":"Before opening a tab for a target, list the open tabs (the list stays private) and offer to attach to a signed-in one, attaching only after the user confirms it once (CEO-10)."},{"oldText":"attach, and don't ask the user again.","newText":"propose attaching to the user's signed-in tab instead of asking for another sign-in (CEO-10)."},{"oldText":"PR #1822 is credited to @Mike-E-Log.","newText":"PR #1822 is credited to @Mike-E-Log, and the CHANGELOG entry credits PR #1743 to @habassa5 (CEO-11)."},{"oldText":"  - the PR gate;","newText":"  - the PR gate, and the full gate tier on the new Claude Code pin (CEO-4);"},{"oldText":"- One PR, separate commits per item, patch version bump.\n","newText":"- One PR, separate commits per item, patch version bump.\n\n### Accepted review amendments\n\nEach amendment below was accepted by the /autoplan review. The item text above names the amendment it folds in; where they differ, the amendment's conditions and tests apply.\n"},{"oldText":"- The MEDIUM summary line names each finding's rule id and file.","newText":"- The MEDIUM summary line names each finding's rule id, file and line (CEO-7)."},{"oldText":"The phase sections stop asking for the key and say how to recover when a dispatch runs in the background.","newText":"The phase sections and the shared foreground-dispatch note ask for the key only when the Agent schema exposes it and say how to recover when a dispatch runs in the background (CEO-20)."},{"oldText":"Every denial that remains names a cause that retrying cannot fix, with the supported fallback.","newText":"Every denial that remains names its cause; none advises a retry that cannot succeed, and every non-transient cause comes with the supported fallback (CEO-3)."},{"oldText":"Fix: when the poll times out, the journal is otherwise `ready`, and every earlier record is consistent, evaluate the current call from the hook payload: tool name, `tool_use_id` and `tool_input` appended after the last journaled event. The payload comes from Claude Code itself and carries the same input the journal record would. Every other check stays exact, so a changed prompt, description or added `model` is still denied.","newText":"Fix: when the first complete read of a `ready` journal lacks the current call and every earlier record is consistent, evaluate the current call from the hook payload: tool name, `tool_use_id` and `tool_input` appended after the last journaled event, for both `Read` and `Agent`; a phase transition counts only a report published in an earlier assistant message (CEO-1). The payload is Claude Code's own schema-normalized input, trusted but not byte-identical to the journal (Cause A shows the difference), so CEO-13 checks its key set against the journal on every new release. A changed prompt or an added `model` is denied on both paths, and a changed description on the journal path (CEO-1)."},{"oldText":"Negative controls: a changed prompt or description, or an added model, stays denied.","newText":"Negative controls: a changed prompt or an added model stays denied on both paths, and a changed description on the journal path."},{"oldText":"and the phase events since snapshot init.","newText":"and the records of the current invocation, from the human turn that started it (CEO-2)."},{"oldText":"When the repo has Greptile (a `greptile.json`, or past Greptile comments on its PRs),","newText":"When the repo has Greptile (a `.greptile/` folder, a `greptile.json`, or past Greptile comments on its PRs),"},{"oldText":"becomes an executable with subcommands (`select-model`, `auth`, `sandbox`, `model-probe`)","newText":"becomes an executable with one subcommand per probe function (CEO-9 lists them)"},{"oldText":"  - for any paid red, the ship-measure loop at the #3059 bar.","newText":"  - the long-session PTY case past 100 MiB (CEO-15), one manual dispatch of the latest-release schema canary (CEO-13), and the macOS measurement step (CEO-6);\n  - for any paid red, the ship-measure loop at the #3059 bar."},{"oldText":"PR and issue text is posted by one argument-array helper, and the remaining free-text sites use it.","newText":"PR and issue text is posted by one argument-array helper, and the remaining free-text sites use it or, where they never call `gh`/`glab`, the agent-written file rule (CEO-23)."},{"oldText":"It covers the remaining free-text sites: question tuning's `--summary-stdin`, /ship's `NEW_TITLE` restore and Step 18, and `docs/gbrain-write-surfaces.md`.","newText":"It covers /ship's `NEW_TITLE` restore and Step 18; question tuning's `--summary-stdin` and `docs/gbrain-write-surfaces.md` move to the agent-written file rule (CEO-23)."},{"oldText":"If either git call fails, it passes nothing, which is today's behavior.","newText":"If either git call fails, it omits only that input, which is today's behavior for it (CEO-23)."}]} -->

Pending TODOS.md writes (the implementation PR writes these; this review edits no repository file except this plan):
- X7: `gstack-doctor` guard check against a named session journal. Effort M (human) / S (CC). P3. Deferred: doctor runs outside a session, design unclear.
- X8: replace `bin/gstack-brain-sync`'s Python secret scanner with `lib/redact-engine.ts`. Effort L / M. P3. Deferred: cross-language rewrite outside A4.

### Phase 1 CEO review: dual voices

Voice snapshot: `/home/user/.gstack/projects/garrytan-gstack/autoplan-ceo-FHMhaX/ceo-implementation.md` (sha256 `4a95d68d…f7f5`). Both voices reviewed that exact input.

**Native CEO voice (Capy subagent, `nativeDispatchPrompt` verbatim): completed.** Returned `INPUT: ceo 4a95d68d…f7f5` (hash matches; native prompt 140 lines read in full). 11 findings: F1 critical (the P0 fix rides with ten unrelated items; split into a hotfix R1 = A1 + pin, R2 = A2/A3/A4, R3 = Tier 2); F2 high (the guard should fail soft, allow with warning, on environment-unverifiable states and keep hard denial for integrity failures); F3 high (Cause B rests on an unreproduced mechanism; PTY first, plus a live publish-then-read case); F4 high (spike a tail read before the two-pass reader); F5 high (weekly canary lags releases; daily or on new versions, version-aware advisory, upstream request); F6 medium (payload is schema-normalized, not "the same input"; assert key-set equality); F7 medium (stuck-sync alarm cannot fire if the drain stops; `last_drain_at`); F8 medium (B2 changes /ship's push order; opt-in, measure first); F9 medium (B3 refactor rides a fix wave); F10 medium (doctor should print Claude Code version, journal size, recent guard codes); F11 medium (P1's version will be stale at merge; verify latest on merge day).

**Codex CEO voice (gpt-6-astra, codex-cli 0.160.1): completed, `OUTSIDE_STATUS: completed provider=codex host=claude`.** 7 findings: #1 high (P1 promises more than its acceptance proves; require live phase transitions or narrow P1 and leave the issue open); #2 high (the plan deepens the private-journal dependency; time-box a supported-hook-event alternative, prove the canary catches a deliberate incompatibility, test a working fallback); #3 high (A4 can publish inconsistent artifact groups; hold coupled groups, restore on a second machine); #4 high (optional work can hold urgent recovery; keep one PR but name the mandatory set and an admission cutoff, produce the eval schedule and cost first); #5 medium (B2 may not deliver faster review; measure, keep optional); #6 medium (no denominator to show guards stopped crying wolf; log attempts and outcomes); #7 medium (blanket contributor rewrite loses tested edge cases). Recommendation: "Revise before implementation because the plan can declare recovery without proving its release promises and can publish partially usable state while optional work delays the fixes."
Classifier note: the installed `lib/outside-review-result.ts` printed `VERDICT: clean` and `FINDINGS: none` for this seven-finding review because it counts only `[P0]`-`[P3]` tags. The verdict line is wrong; the completed text is the evidence used here. Fix accepted as CEO-28.

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Premises valid?                   No      No     CONFIRMED (payload premise, P1 proof, fail-closed unexamined)
  2. Right problem to solve?           Yes*    Yes*   CONFIRMED (*with a dependency reframe)
  3. Scope calibration correct?        No      No     CONFIRMED issue; DISAGREE on remedy (split vs cutoff) -> taste
  4. Alternatives sufficiently explored?No     No     CONFIRMED (advisory, tail read, supported surface)
  5. Competitive/market risks covered? No      No     CONFIRMED (Claude Code changes faster than the pin)
  6. 6-month trajectory sound?         No      No     CONFIRMED (another version-specific reprieve)
CONFIRMED = completed native subagent + completed Codex.
```

**Integration of voice findings.**
- User Challenge UC1 (both voices): when the guard cannot verify for reasons that are Claude Code's, not the model's (unrecognized shape, a record that never flushes, a rewritten journal, an unseen Claude Code version), allow with a visible warning and a log line instead of a hard deny; keep hard denial for integrity failures (changed prompt, added `model`, cross-phase sibling, missing journaled report). Native F2 and Codex #2 both say the current fail-closed stance turns each Claude Code change into an outage. The user's direction (exact checks, named hard denials) stands until the gate.
- User Challenge UC2 (both voices): B2 ships behind an opt-in and becomes the default only after a measured net improvement (native F8, Codex #5). The user's direction (B2 on whenever Greptile is present) stands until the gate.
- Taste T4: native F1/F9 recommend splitting the release (hotfix first); Codex #4 keeps one PR with a mandatory set and admission cutoff. Auto-decided one PR plus CEO-26 (Garry's standing one-PR rule; P6). Alternative: R1 hotfix with A1 + pin, ships /autoplan days earlier, costs a second release cycle and a second eval census.
- Taste T5: Codex #7 (contributor rewrites). Auto-decided CEO-31: the rewrite policy stays, contributors' passing regression tests are reused. Alternative: drop the blanket rewrite rule.
- Accepted as mechanical: CEO-24 (F3, Codex #1), CEO-25 (F4), CEO-13 daily schedule, key-set equality, injected-strip fixture and merge-day run (F5, F6, F11, Codex #2), CEO-12 allow lines (Codex #6), CEO-27 (Codex #3, F7), CEO-29 (F10), CEO-30 (F5), CEO-28 (classifier defect found in this run), baseline edit correcting the payload premise (F6).
- Not adopted: native F5's version-aware advisory (part of UC1, waits for the gate); Codex #6's post-release baseline and review owner (gstack has no central telemetry for this; the local log is what users attach to reports); Codex #2's supported-hook-event state machine as a build item (CEO-30 asks upstream for that surface; no supported event carries the published text today).

### Phase 1 CEO review: sections 1-10

Current scope: mode SELECTIVE EXPANSION (override); governing rows CEO-D1 (approach A), X1-X6 accepted, X7/X8 deferred, X9/X10 skipped (X10 conditional), CEO-1..CEO-31 accepted; UC1 and UC2 pending at the gate.

**Section 1: Architecture.**
```
                         Claude Code (external, unpinned for users)
         PreToolUse payload |            | journal (~/.claude/projects/<p>/<s>.jsonl)
                            v            v
  autoplan/bin/phase-publication-hook.ts --[two-pass or tail reader, CEO-2/25]--> lib/claude-journal-records.ts (new, shared)
     | journal path (exact, minus run_in_background)        ^ also used by readPlanCountTranscript (tests, PTY runners)
     | payload path (CEO-1: allowlist, messageId rule)      |
     +--> consumption() -> snapshot manifests (bin/gstack-autoplan-snapshot.ts)
     +--> requirePublication() -> autoplan-phase-publication.ts
     +--> analytics/autoplan-guard.jsonl (CEO-12)          canary: autoplan-schema-canary (CEO-13, daily, latest CC)

  git push -> bin/gstack-redact-prepush --(selfEmail, repoPublicEmails: config + bounded git log)--> lib/redact-engine.ts
  skill end -> bin/gstack-brain-sync (per-path/group holds, held status, last_drain_at) -> skill start ARTIFACTS_SYNC line
  /ship -> early PR + @greptileai (B2) -> gstack-post (B4) -> gstack-redact -> gh/glab argv
  skills -> gstack-codex-probe <subcommand> (B3) ; gstack-doctor (B5) reads probes, caches, guard log
```
Data flow, payload path: happy (ready journal, call absent, consistent) -> evaluate from payload; nil (no journal yet) -> wait window, then the named "journal not created" denial; empty (journal with no owned turn) -> existing unflushed handling; error (identity, rewritten prefix) -> hard denial with fallback. State: phase state machine unchanged (ceo -> design? -> dx? -> eng -> tasks); the new invalid transition prevented is "enter next phase with the report in the same unflushed message" (messageId rule). Coupling: the hook gains a shared record module and a payload trust path; justified by #100051. Scaling: per-guarded-call cost grows with journal size under the two-pass design; CEO-25 checks a tail read that scales with the invocation instead. Single points of failure: Claude Code's journal format (UC1 addresses the blast radius) and the codex probe. Security architecture: no new endpoints; new trust inputs are the hook payload (Claude Code) and the status file (local, possibly pulled). Rollback: revert the commit and re-run `./setup` (minutes); the pin bump reverts independently. Elegant to a new engineer: one record module, one reason-code table, one publication rule. Platform: the reason codes and decision log feed doctor and bug reports.
Findings: 3. (a) Fail-closed blast radius on Claude Code drift -> UC1. (b) A4 can publish partial artifact generations -> CEO-27. (c) Payload premise misstated -> baseline edit. Decision gate: resolved as recorded.

**Section 2: Error & Rescue Map.**
```
  METHOD/CODEPATH                      | WHAT CAN GO WRONG                         | CLASS
  runPublicationHook (payload path)     | call absent, journal ready                 | unflushed (handled: payload eval)
                                        | report only in same/last message           | publication_unflushed (deny, publish-separately)
                                        | Agent key outside allowlist / model added  | input_binding (hard deny)
  owned reader (CEO-2/25)               | prefix rewritten during invocation         | rewritten (hard deny + fallback)
                                        | single record > 32 MiB                     | too_large (hard deny + fallback)
                                        | journal not created                        | ENOENT (wait window, then named denial)
                                        | unknown root shape                         | unrecognized_shape (advisory, existing)
  gstack-redact-prepush A3              | git config/log fails or exceeds 50k/5 s    | omit that input (today's behavior)
  gstack-brain-sync drain A4            | git add/reset fails                        | reported, status error
                                        | stale index.lock                           | removed only under drain lock and >10 min
                                        | re-scan after hold still flags             | full unstage + blocked (existing)
                                        | drain never runs                           | last_drain_at alarm (CEO-27)
  /ship B2                              | Greptile never completes                   | 10 min cap -> unavailable
                                        | B4 absent                                  | gh --body-file fallback
  gstack-post B4                        | HIGH finding / MEDIUM finding / gh fails   | refuse / return to caller / exit with gh error
  gstack-codex-probe subcommands B3     | model unusable, sandbox unavailable        | existing CODEX_MODE branches via exit codes
  gstack-doctor B5                      | probe cache missing                        | "not probed" row, --live to run

  CLASS                 | RESCUED? | RESCUE ACTION                               | USER SEES
  unflushed             | Y        | payload evaluation                          | nothing (allowed)
  publication_unflushed | Y        | deny with exact fix                         | "publish the report in its own message ..."
  input_binding         | N (by design) | hard deny                              | named cause + fallback
  rewritten / too_large | N (by design) | hard deny                              | named cause + fallback (UC1 may soften)
  A3 git failure        | Y        | omit input                                  | today's warning
  A4 git failure        | Y        | report, keep queue                          | attention line at skill start
  Greptile timeout      | Y        | unavailable path                            | "Greptile triage did not complete"
  gstack-post MEDIUM    | Y        | caller's per-finding question               | question before posting
```
No catch-all rescue is added; the hook's final catch maps to a named "installation unavailable" denial today and gets a CEO-3 code. GAPS: 0 after CEO-17/27 (the drain-never-runs path was the one silent gap).

**Section 3: Security & threat model.**
- B6 attach-to-any-tab (High likelihood if unfixed, Medium impact: reading or acting in a tab the user did not offer): mitigated by CEO-10 (confirm once, show only the named origin's tabs).
- A4 attention line as an injection channel (Medium/Medium: the status message carries scanner snippets with up to 30 characters of a secret, and a pulled checkout could plant text): mitigated by CEO-17 (fixed text, clamped codes, no message).
- B4 posting without redaction (Medium/High: free text to public PRs): mitigated by CEO-19 (scan exact bytes; HIGH refuses; MEDIUM returns to the caller).
- A3 email suppression abuse (Low/Low: an author can set someone else's email to suppress a MEDIUM PII warning; HIGH secrets are unaffected): accepted, documented.
- Payload path trust (Low/Medium: a forged payload would need control of Claude Code itself): accepted; the guard is an anti-skip barrier, not an adversarial boundary.
- B2 early push of unreviewed code on public repos (Medium/Medium: secrets still blocked by the pre-push hook, but code becomes public before /ship's review): routed to UC2 (opt-in).
- Dependencies: none new. Secrets: none new. Issues found: 6, all mitigated or routed.

**Section 4: Data flow and interaction edge cases.**
```
  Flush ordering (one assistant message M = [report text, Read(next driver)]):
  time ->     Claude Code writer            hook process                 shared state (journal)
  t0          M finalized, held             -                            ...prev messages
  t1          PreToolUse fires              read journal                 ...prev (M absent)
  t2          (lagging) waits for result    payload path: report in M?   M absent -> report not journaled
  t3          -                             deny publication_unflushed   -
  Fixed flow: M1 = [report text, Bash ": autoplan-published ceo"] ; M2 = [Read(next driver)]
  t1'         M1 tool runs, result lands -> M1 + result written           ...M1, result
  t2'         M2 PreToolUse fires           read journal                 M1 followed by result -> counts
```
Both completion orders for a lagging and a fast writer give the same verdict under the messageId rule (CEO-1), which is the invariant. A partial flush (text written, tool_use not) is the other order and is denied (fixture in CEO-1). Interaction edge cases: double-dispatch of the same phase (sibling rule), compaction mid-phase (existing logical-parent handling plus CEO-2 window), `reused:true` re-init (CEO-2 anchor, existing tests kept), two drains racing (singleton lock), Greptile comments on a stale head (triaged against final diff), held file edited then re-queued (re-scan clears). Unhandled: 0 after amendments.

**Section 5: Code quality.** `autoplan/bin/phase-publication-hook.ts` is 633 lines; adding the payload path, allowlist and reason codes risks the 800-line owner-module ratchet (`test/module-size-ratchet.test.ts`), so the shared record module and a reason-code table belong outside it. `lib/claude-public-transcript.ts` (596 lines) gets smaller once extraction moves to `lib/claude-journal-records.ts`. `bin/gstack-brain-sync` (1012-line bash) gains per-path logic; keep it in the existing embedded Python, not new bash. B3's ten subcommands replace sourced functions with one dispatcher; no duplication if generated blocks stop defining helpers inline. Issues: 2 (module size, brain-sync scanner duplication deferred as X8).

**Section 6: Tests.** Every new codepath has a named test in the accepted block: payload path, messageId rule, sibling batch, allowlist (CEO-1); reader prefix, rewrite, record bound, window anchor, Skill-tool start, reused init (CEO-2); denial inventory text (CEO-3); guard log lines (CEO-12); schema canary plus injected-strip fixture (CEO-13); A3 true-positive controls plus independent fallbacks (CEO-23); A4 held, privacy, lock, liveness and coupled-group restore (CEO-17/27); Greptile trigger decisions (CEO-8); `gstack-post` HIGH and MEDIUM (CEO-19); probe subcommands in bash and zsh (CEO-9); classifier fixture (CEO-28). 2am-Friday test: the PTY run through every phase transition on default 2.1.292 (CEO-24). Hostile QA: a journal whose current message is partially flushed. Chaos: appends during a 120 MiB read. Flakiness risk: PTY and paid cases (rule kind, one trial; failures go to the #3059 measure loop, no retries). Prompt changes (phase sections, phase-close, foreground note, aside rules, brain-sync preamble) run CEO-18's generation, parity and size checks before their evals. Gaps: 0 after amendments.

**Section 7: Performance.** Hot path: the hook's journal read on each guarded call. Measured: the current full reader takes 440-500 ms and ~684 MiB RSS at 120 MiB (synthetic, 4 vCPU); CEO-2 bounds memory and CEO-25 can make cost proportional to the invocation. CEO-1 removes the 2-second wait per lone guarded call (~25-50 calls per run, up to ~100 s saved). A3 history read bounded to 50,000 commits and 5 s. B2 adds up to 10 minutes of polling in /ship only when Greptile is present (UC2). Issues: 1 (per-call cost growth), mitigated by CEO-25.

**Section 8: Observability.** New: per-decision guard log (CEO-12), reason codes (CEO-3), doctor triage rows (CEO-29), sync `held` status, `drainable`, `last_drain_at` and the `--status` held array (CEO-14/17/27), schema canary reporting to the periodic report job (CEO-13). Runbooks: `docs/autoplan-guard-troubleshooting.md` gains rows for each new code. Debuggability three weeks out: a user report with doctor output and the guard log names the Claude Code version, path and code. Gaps: 0 after amendments.

**Section 9: Deployment and rollout.** No migrations. Rollout risk window: users on the old guard keep failing until they upgrade; release notes tell #3062 reporters the upgrade command and the `CLAUDE_CODE_FORK_SUBAGENT=false` workaround for older installs. B3's one-release sourcing compatibility covers skills rendered before upgrade. Feature flag: only B2 if UC2 is accepted. Post-deploy: merge-day canary run on latest (CEO-13), issue closure checks per Tracker hygiene. Rollback: per-commit revert, re-run `./setup`. Risks flagged: 2 (pin bump moves every PTY case's TUI, covered by CEO-4; B2 changes /ship push order, UC2).

**Section 10: Long-term trajectory.** Debt: the guard still depends on private journal behavior (UC1 and CEO-30 are the exits); B3 leaves a one-release compatibility shim with a named removal. Reversibility: 4/5 (all items revert per commit; B2 and the probe contract are the least reversible once other skills depend on them). Path dependency: CEO-1's payload heuristics become unnecessary if Claude Code adds `messageId` to PreToolUse (CEO-30). The 1-year question: one record module, one reason table and one write path are obvious to a new engineer; the payload heuristic needs its #100051 comment. Phase 2: supported hook surface; Phase 3: retire journal reading. Retrospective on cherry-picks: X4 was accepted on a wrong premise and had to be redesigned (now CEO-13); X7 (doctor guard check) partly returns as CEO-29's lighter rows. Debt items: 2.

**Section 11: Design & UX.** SKIPPED (no UI scope).

### Phase 1 CEO review: required outputs

**NOT in scope.** Deferred (pending TODOS.md writes): X7 doctor guard check against a named journal (design unclear); X8 brain-sync scanner unification (L, cross-language); the /cso Windows transport (#3028, plan's own deferral). Rejected: X9 parsed-prefix cache (not the bottleneck; adds a forgeable input); X10 bg preflight (superseded unless CEO-5 reopens it); Codex #6's post-release baseline owner (no central data); #3061, #3058 and Dependabot #3053 (plan's own exclusions).

**What already exists.** See the 0B table: the hook's pending-Read path (generalized by CEO-1), the owned reader and test seam (CEO-2), the redact engine's email exemptions (A3), the drain's retained set, status writer and skill-start block (A4), `gstack-slug --classify-checkpoints` (B1), the Greptile section (B2), the probe's ten functions (B3), the free-text file rule and `gstack-redact` (B4), `./setup --status` and the probe cache (B5), the aside rules and cookbook (B6), the journal-drift canary (CEO-13), `outside-review-result.ts` (CEO-28).

**Dream state delta.** After this plan: /autoplan works on current Claude Code with a canary on the latest release, bounded memory on long sessions, honest denials and a decision log; pre-push and sync guards are precise and visible. Still short of the 12-month ideal: the guard depends on a private journal (UC1/CEO-30), flush timing has no automated canary, and there is no supported publication surface.

**Error & Rescue Registry.** The Section 2 tables are the registry: 18 codepath rows, 0 critical gaps after amendments.

**Failure Modes Registry.**
```
  CODEPATH              | FAILURE MODE                     | RESCUED? | TEST? | USER SEES?               | LOGGED?
  guard payload path    | report in same message           | Y        | Y     | publish-separately text  | Y
  guard payload path    | schema adds unknown Agent key    | N        | Y*    | hard deny (all dispatch) | Y      (*canary; UC1 would soften)
  guard reader          | 120 MiB journal                  | Y        | Y     | nothing                  | Y
  guard reader          | rewritten prefix                 | N        | Y     | named deny + fallback    | Y
  pre-push A3           | history read overrun             | Y        | Y     | today's warning          | N
  brain-sync A4         | drain stops running              | Y        | Y     | attention line           | Y
  brain-sync A4         | held file in coupled group       | Y        | Y     | held status + --status   | Y
  /ship B2              | Greptile never completes         | Y        | Y     | unavailable line         | Y
  gstack-post B4        | MEDIUM PII in body               | Y        | Y     | caller's question        | N
  probe B3              | stale skill sources old probe    | Y        | Y     | works for one release    | N
  outside voice         | high findings classified clean   | Y        | Y     | correct verdict          | Y      (CEO-28)
```
Critical gaps (RESCUED=N, TEST=N, silent): 0.

**Diagrams produced:** system architecture, data flow with shadow paths (Section 1), flush-ordering schedule (Section 4), error flow (Section 2). State machine: unchanged phase machine plus the one new invalid transition (described in Section 1). Deployment sequence and rollback: per-commit revert (Section 9). **Stale diagrams:** the ASCII comment above `ownedCausalLines` and the hook's flush comment (`:479-481`) become stale under CEO-1/CEO-2 and must be updated.

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | guard breaks weekly on Claude Code changes; |
  |                      | flush lag documented upstream (#100051)     |
  | Step 0               | approach A; 10 cherry-picks (6 accepted)    |
  | Section 1  (Arch)    | 3 issues found                              |
  | Section 2  (Errors)  | 18 error paths mapped, 0 GAPS               |
  | Section 3  (Security)| 6 issues found, 0 High unmitigated          |
  | Section 4  (Data/UX) | 9 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 2 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 1 issue found                               |
  | Section 8  (Observ)  | 0 gaps found                                |
  | Section 9  (Deploy)  | 2 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (9 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 18 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 11 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 2 items proposed (pending writes)           |
  | Scope proposals      | 10 proposed, 6 accepted (EXP + SEL)         |
  | CEO plan             | written                                     |
  | Outside voice        | codex completed; native completed           |
  | Lake Score           | N/A (no coverage-scored questions)          |
  | Diagrams produced    | 4 (architecture, data flow, schedule, error)|
  | Stale diagrams found | 2                                           |
  | Unresolved decisions | 2 (UC1, UC2, at the final gate)             |
  +====================================================================+
```
Unresolved decisions: UC1 (fail-soft on environment-unverifiable guard states) and UC2 (B2 behind opt-in) wait for the user at the final gate.

### Phase 1 CEO review: Implementation Tasks
Synthesized from this review's findings (assumption: human/CC ratios ~20x for fixes, ~5x for design spikes).

- [ ] **T1 (P1, human: ~1 day / CC: ~1.5h)** — autoplan guard — Payload path, Agent allowlist, messageId publication rule, sibling batch (CEO-1)
  - Surfaced by: Step 0 premise 1; spec reviews; native F3
  - Files: autoplan/bin/phase-publication-hook.ts, test/autoplan-publication-guard.test.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T2 (P1, human: ~4h / CC: ~30min)** — autoplan sections — Phase-close publishes with ': autoplan-published <phase>'; conditional run_in_background wording at every site (CEO-1, CEO-20)
  - Surfaced by: Step 0 probe phase-close:40-42; spec review 3
  - Files: autoplan/sections/phase-close.md.tmpl, scripts/resolvers/constants.ts, scripts/resolvers/design.ts, scripts/resolvers/outside-voice-steps.ts, scripts/resolvers/review-army.ts, scripts/resolvers/spec-review.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T3 (P1, human: ~2 days / CC: ~2h)** — journal reader — Bounded append-tolerant reader after tail-read spike; shared record module (CEO-2, CEO-25)
  - Surfaced by: Step 0 premise 2; native F4
  - Files: lib/claude-public-transcript.ts, lib/claude-journal-records.ts, scripts/measure-journal-read.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T4 (P1, human: ~4h / CC: ~30min)** — guard codes — Reason code per fail() site, denial inventory, decision log (CEO-3, CEO-12)
  - Surfaced by: Step 0 premise 3; Codex #6
  - Files: autoplan/bin/phase-publication-hook.ts, docs/autoplan-guard-troubleshooting.md
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T5 (P1, human: ~1 day / CC: ~1h)** — CI pin — Pin Claude Code 2.1.292, full gate tier, PTY-first reproduction incl. --bg attach and live transitions (CEO-4, CEO-5, CEO-24)
  - Surfaced by: Dockerfile.ci:127-138 rule; native F3; Codex #1
  - Files: .github/docker/Dockerfile.ci, test/helpers/pty/launch.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T6 (P1, human: ~4h / CC: ~45min)** — canary — autoplan-schema-canary daily on latest Claude Code with key-set equality and injected-strip fixture (CEO-13)
  - Surfaced by: native F5/F6; spec review 1
  - Files: test/skill-e2e-autoplan-schema-canary.test.ts, test/helpers/touchfiles-data.ts, .github/workflows/evals-periodic.yml
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T7 (P1, human: ~4h / CC: ~45min)** — long session — Paid PTY case on a journal padded past 100 MiB before a compact boundary (CEO-15) plus macOS/Linux measurement dispatch (CEO-6)
  - Surfaced by: spec review 1-3
  - Files: test/skill-e2e-autoplan-long-session.test.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T8 (P1, human: ~4h / CC: ~20min)** — pre-push — selfEmail and bounded repoPublicEmails incl. tracking refs; rule/file/line summary; independent fallbacks (A3, CEO-7, CEO-23)
  - Surfaced by: Step 0 probe redact-prepush:521
  - Files: bin/gstack-redact-prepush, test/redact-prepush.test.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T9 (P1, human: ~2 days / CC: ~2h)** — artifacts sync — Per-path and coupled-group holds, held status, drainable and last_drain_at, safe index.lock, fixed attention line, --status held array (A4, CEO-14, CEO-17, CEO-27)
  - Surfaced by: Step 0 probes brain-sync:727-736; Codex #3; native F7
  - Files: bin/gstack-brain-sync, bin/gstack-skill-start, scripts/resolvers/preamble/generate-brain-sync-block.ts, test/brain-sync.test.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T10 (P2, human: ~2h / CC: ~15min)** — outside voice — Classifier counts severity words so high findings never read clean (CEO-28)
  - Surfaced by: Discovered in CEO outside voice
  - Files: lib/outside-review-result.ts, test/outside-review-result.test.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T11 (P2, human: ~1 day / CC: ~1h)** — ship Greptile — Early PR, draft trigger, completion signal, ready transition (B2, CEO-8; UC2 pending)
  - Surfaced by: Landscape: Greptile skips drafts
  - Files: ship/sections/greptile.md.tmpl, ship/SKILL.md.tmpl
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T12 (P2, human: ~1 day / CC: ~1h)** — codex probe — Ten subcommands with KEY: value contract; generated blocks use them; zsh self-locate kept (B3, CEO-9)
  - Surfaced by: Step 0 premise 6; spec review 1/3
  - Files: bin/gstack-codex-probe, scripts/resolvers/outside-voice.ts, scripts/resolvers/constants.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T13 (P2, human: ~1 day / CC: ~1h)** — posting helper — gstack-post with redaction of exact bytes, MEDIUM back to caller; file rule for non-gh sites (B4, CEO-19, CEO-23)
  - Surfaced by: spec reviews 1/3
  - Files: bin/gstack-post, ship/sections/pr-body.md.tmpl, scripts/resolvers/redact-doc.ts, scripts/resolvers/question-tuning.ts, docs/gbrain-write-surfaces.md
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T14 (P2, human: ~4h / CC: ~30min)** — doctor — gstack-doctor rows incl. Claude Code version, journal size, guard codes; no paid probe by default (B5, CEO-21, CEO-29)
  - Surfaced by: native F10; Section 7
  - Files: bin/gstack-doctor, setup
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T15 (P2, human: ~4h / CC: ~30min)** — context-restore — Below-cwd scan, task match, conditional pointer (B1, CEO-22)
  - Surfaced by: #3065
  - Files: context-restore/SKILL.md.tmpl, context-save/SKILL.md.tmpl, bin/gstack-slug
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T16 (P2, human: ~2h / CC: ~15min)** — browse rules — Rule 1 consent kept, rule 6 wording, press form, cookbook detail (B6, CEO-10)
  - Surfaced by: Step 0 premise 7
  - Files: scripts/resolvers/aside.ts
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change
- [ ] **T17 (P3, human: ~2h / CC: ~15min)** — release hygiene — Credits for #1822 and #1743, TODOS.md edits, upstream claude-code request, generation and parity checks (B7, CEO-11, CEO-16, CEO-18, CEO-30)
  - Surfaced by: Step 0 probe gh pr view 1743
  - Files: CHANGELOG.md, browse/test/extension-sender-auth.test.ts, TODOS.md
  - Verify: the named tests in the cited CEO obligation, then CEO-18's generation and parity checks where templates change

### Phase 1 close and Phase 2

Phase 1 close packet `/home/user/.gstack/projects/garrytan-gstack/autoplan-ceo-HwsVO4/close-packet.md` (179 lines) read through EOF and verified against the accepted decisions; report published to the parent. CEO tasks JSONL: `/home/user/.gstack/projects/garrytan-gstack/tasks-ceo-review-20261007-155246.jsonl` (17 tasks).

**Phase 2 (design) skipped: no UI scope detected.** This is a skip, not a completed review; outside_status skipped.

### Phase 2.5 DX review: Step 0

DX methodology `/home/user/.gstack/projects/garrytan-gstack/autoplan-dx-methodology-M2q68R/methodology.md` (2128 lines) read through EOF: 1-36 and 420-2128 read directly; 37-419 (shared preamble) verified byte-identical, apart from the skill name, to the CEO methodology's preamble already read; 1360-1599 (skip-listed outside voice) loaded only. Mode: DX POLISH (override). No prior DX reviews (`gstack-review-read` has no `plan-devex-review` rows).

**Product type (auto-confirmed):** Claude Code skill suite plus CLI helpers (`bin/gstack-*`). The plan's developer surface: the /autoplan guard and its denial messages, the pre-push hook output, the `ARTIFACTS_SYNC:` skill-start line and `gstack-brain-sync --status`, /ship's Greptile flow, `gstack-codex-probe` subcommands, `gstack-post`, `gstack-doctor`, the browse cookbook and /context-restore prompts.

```
TARGET DEVELOPER PERSONA
========================
Who:       Technical founder or staff engineer who runs gstack inside Claude Code every day on their own repos (README "Who this is for").
Context:   Upgraded Claude Code to the latest release (2.1.292) and ran /autoplan on a plan; or pushed a branch; or noticed artifacts stopped syncing.
Tolerance: About 2 minutes of recovery before they abandon /autoplan for manual reviews or bypass a guard with --no-verify.
Expects:   One upgrade command fixes it; any denial says what is wrong, why, and the exact next command.
```

**Empathy narrative (observed evidence from #3062/#3060/#3055; predictions labeled).** "I updated Claude Code yesterday and typed `/autoplan docs/plan.md`. The CEO methodology Reads came back `[autoplan] Native parent evidence has not reached the journal yet. Retry this phase-entry tool` (observed, #3062). I retried; same text, every time (observed: a solo retry is always first in its message). I searched the issues and found a thread telling me to set `CLAUDE_CODE_FORK_SUBAGENT=false` and relaunch without `--bg` (observed). Twenty minutes gone. Meanwhile every push prints `N MEDIUM finding(s) ... Review before this becomes public` with no file or rule (observed, #3060), so I have started ignoring it. My artifacts have not synced in weeks and nothing told me (observed, #3055). After this wave I expect (predicted): `/gstack-upgrade`, rerun `/autoplan`, and Phase 1 starts; if the guard does stop me, it says which message to send and the exact no-op command, with a docs link; the pre-push hook names `pii.email docs/x.md:12`; skill start says one file is held and how to see it."

**Competitive DX benchmark (WebSearch; Aside not available on Linux).**

| Tool | Start -> result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| Claude Code `claude doctor` / `/doctor` | broken setup -> named diagnosis | seconds (reported) | read-only CLI doctor without a session; in-session doctor proposes fixes | code.claude.com/docs/en/debug-your-config |
| Claude Code `claude update` | old -> current version | about 30 s (estimated) | one command | Claude Code docs |
| gstack today (affected user) | upgrade CC -> /autoplan Phase 1 | blocked; ~20+ min to find the workaround (observed in #3062 thread) | retry denial, no doc anchor | #3062 |
| gstack after plan (predicted) | `/gstack-upgrade` -> /autoplan Phase 1 entered | ~2-3 min (estimated: ~1 min upgrade + ~1 min to Phase 1) | upgrade fixes it; named denials with anchors | this plan |

**TTHW target (auto-decided, P5):** Competitive (2-5 min) for the clock "start: an affected user runs `/gstack-upgrade`; result: /autoplan enters Phase 1 on Claude Code latest, default settings." Champion (< 2 min) is not reachable because `./setup` rebuilds binaries.

**Magical moment (auto-decided, lowest-effort vehicle):** the first `/autoplan` after upgrading simply enters Phase 1 with no denial, and if a denial does appear it contains the exact one-line fix (`: autoplan-published <phase>` or the fallback reviews) and a docs anchor. Vehicle: existing guard messages plus `docs/autoplan-guard-troubleshooting.md` anchors; no new surface.

**Developer journey (0F, DX POLISH traces all stages).**
```
STAGE           | DEVELOPER DOES                                   | FRICTION POINTS                                         | STATUS
----------------|--------------------------------------------------|---------------------------------------------------------|--------
1. Discover     | hits a denial / reads release notes              | denial text says "retry"; no anchor                     | fixed (CEO-3, DX-1)
2. Install      | /gstack-upgrade or git pull && ./setup           | unclear whether to drop the FORK_SUBAGENT workaround    | fixed (DX-2)
3. Hello World  | /autoplan plan.md enters Phase 1                 | lagging journal; publication protocol changed           | fixed (CEO-1, DX-3), live proof CEO-24
4. Real Usage   | phases complete; pushes; syncs                   | MEDIUM summary unreadable; silent sync stall            | fixed (CEO-7, CEO-17, DX-4, DX-5)
5. Debug        | gstack-doctor, --status, guard log               | doctor output format and exit codes undefined           | fixed (DX-6, DX-13)
6. Upgrade      | next release; stale rendered skills              | sourced probe and old phase-close text                  | fixed (DX-3, DX-7)
```

**First-time developer confusion report (0G, grounded in current code).**
```
FIRST-TIME DEVELOPER REPORT
Persona: daily gstack user on Claude Code 2.1.292
Attempting: /autoplan after upgrading gstack
T+0:00  Runs /gstack-upgrade; setup rebuilds; sees version line.
T+1:00  Runs /autoplan plan.md. Phase 1 Reads go through (payload path).
T+6:00  Phase 1 closes; the model publishes the report and the next driver Read in one message (old habit or old rendered text).
T+6:02  Denial: "[autoplan] The Phase 1 report is in the same message as this phase-entry call ... publish it in its own message with `: autoplan-published ceo`" + anchor (predicted wording, DX-1/DX-3). Confused for a moment, follows it.
T+6:30  Phase 2.5 starts. Success. Confusion points: the publication protocol change (addressed by the denial text) and whether the old env workaround should stay (DX-2).
```

### Phase 2.5 DX review: dual voices

Voice snapshot: `/home/user/.gstack/projects/garrytan-gstack/autoplan-dx-MkZn7h/dx-implementation.md` (sha256 `4174d402…0ba0`).

**Claude SUBAGENT (DX — independent review): completed.** `INPUT: dx 4174d402…0ba0` (hash matches). 0 critical, 6 high, 9 medium: helpers not on PATH in user-facing text; `gstack-post` interface and confirm path; guard docs not a deliverable and the current page contradicts P1; B2 has no opt-out; no per-email allow for pre-push; (high, counted with docs) misleading retry guidance. Medium: in-flight session after upgrade; setup-status/doctor link; three A4 staleness predicates; `--skip-file` permanent; B3 naming/help/deprecation; runnable fallback commands; A3 partial history; doc touchpoints and the CEO-28 either/or; guard advisory mode plus doctor `--json`, log rotation, bound overrides, no-op permission check.

**Codex SAYS (DX — developer experience challenge): completed, `OUTSIDE_STATUS: completed provider=codex host=claude`.** 8 findings: high: post-after-approval has no contract; `select-model` drops the per-request `--model` precedence (tested in `test/codex-model-probe.test.ts:282`); one-release sourcing window is unsafe; early PR still automatic despite the open challenge. Medium: doctor cannot tell optional-absent from broken; recovery docs not an acceptance requirement (and `docs/troubleshooting.md:53` teaches sourcing); `--skip-file` is permanent with no undo; novice hello world under 5 minutes is unproven. Recommendation: "revise before implementation because approval resumption, model-selection compatibility, upgrade continuity, and early-publication defaults lack complete developer-facing contracts". The installed classifier again printed `VERDICT: clean`/`FINDINGS: none` for an eight-finding review (CEO-28 defect, second occurrence).

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          Gaps    Gaps   CONFIRMED gap (Claude: recovery path ~2 steps but bare commands; Codex: novice journey unmeasured)
  2. API/CLI naming guessable?         No      No     CONFIRMED (gstack-post contract, probe naming/--model)
  3. Error messages actionable?        No      No     CONFIRMED (anchors, runnable fallbacks, docs as deliverable)
  4. Docs findable & complete?         No      No     CONFIRMED (touchpoint list, stale retry/sourcing docs, PATH)
  5. Upgrade path safe?                No      No     CONFIRMED (in-flight session; compat window and deprecation)
  6. Dev environment friction-free?    No      No     CONFIRMED (doctor states; Windows; log growth)
CONFIRMED = completed native subagent + completed Codex.
```

Integration: UC2 (B2 opt-in) is reinforced by both DX voices (Claude high, Codex high), a cross-phase theme. Taste T6: pre-push per-email allowlist (Claude only; accepted provisionally as DX-17). Taste T7: B3 compatibility window of at least one release and 14 days (Codex high, Claude asked for a deprecation notice; the plan said "one release"; accepted provisionally as DX-18). Guard advisory mode (Claude medium) is part of UC1. Deferred (DX POLISH, no new surfaces): doctor `--json`; env overrides for the A3 bounds (the partial-history rule covers monorepos); a timed novice install journey (Codex #8: out of this fix wave's scope).

### Phase 2.5 DX review: passes 1-8 (pre-fix -> post-fix)

**Pass 1 Getting Started: 2 -> 7.** Recovery journey (the wave's hello world): today blocked with no working path; after the plan, `/gstack-upgrade` then `/autoplan` (2 steps, ~2-3 min estimated). Gaps were bare command names and the unmeasured clock: DX-2, DX-16. What 10 looks like: measured upgrade-to-Phase-1 under 2 minutes in both session kinds; not reachable while `./setup` rebuilds binaries.

**Pass 2 API/CLI design: 5 -> 8.** `gstack-doctor` matches the `gstack-*` convention and mirrors Claude Code's `claude doctor`. Fixed: `gstack-post` synopsis and exit codes (DX-6), probe naming, help and `--model` precedence (DX-7), doctor states (DX-8). Residual: two readiness entry points, now linked.

**Pass 3 Error messages: 3 -> 8.** Traced three paths. (1) Guard lone call: today "Native parent evidence has not reached the journal yet. Retry this phase-entry tool" (no fix, retry useless); after CEO-1 allowed, and any remaining denial names cause, fix, runnable fallback and anchor (DX-1). (2) Pre-push: today "N MEDIUM finding(s) ... Review before this becomes public" (no rule/file); after: `MEDIUM pii.email docs/x.md:12` with a fix line (CEO-7, DX-9, DX-17). (3) Sync stall: today silent; after a fixed attention line with the absolute `--status` path (CEO-17, DX-2, DX-4).

**Pass 4 Documentation: 4 -> 7.** The troubleshooting page currently tells users to retry non-transient codes and says the cap has no override reason that A2 changes; `docs/troubleshooting.md` teaches sourcing. Fixed by DX-1 and DX-12. Residual: docs are prose, no interactive check beyond doctor.

**Pass 5 Upgrade path: 5 -> 8.** In-flight sessions (DX-3), deprecation notice and window (DX-7, DX-18), snapshot compatibility (CEO-1's hook-constant allowlist), TODO removals tied to acceptance (CEO-16).

**Pass 6 Dev environment: 6 -> 7.** macOS measurement (CEO-6), Windows coverage for new helpers (DX-15), no paid probe by default (CEO-21), bounded guard log (DX-14). Residual: no doctor `--json` (deferred).

**Pass 7 Community: 7 -> 8.** Credits fixed (CEO-11), contributor tests reused (CEO-31), upstream request (CEO-30), doctor output in the issue template (CEO-29, DX-2).

**Pass 8 DX measurement: 3 -> 6.** Guard decision log with a denominator (CEO-12), recovery TTHW recorded once (DX-16). Residual: data stays on users' machines; no recurring measurement owner (not proposed; would need a policy decision).

**Claude Code skill checklist (appendix).** Checked against the plan: skills regenerate from templates (CEO-18); preflight probes are executed commands (B3); every denial is problem + cause + fix (DX-1); hooks fail with named causes; outside-voice verdicts parse correctly (CEO-28/DX-11). Unchecked items: none beyond those addressed.

### Phase 2.5 DX review: required outputs

**DX Scorecard.**
```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  7/10  |  2/10  |  +5    |
| API/CLI/SDK          |  8/10  |  5/10  |  +3    |
| Error Messages       |  8/10  |  3/10  |  +5    |
| Documentation        |  7/10  |  4/10  |  +3    |
| Upgrade Path         |  8/10  |  5/10  |  +3    |
| Dev Environment      |  7/10  |  6/10  |  +1    |
| Community            |  8/10  |  7/10  |  +1    |
| DX Measurement       |  6/10  |  3/10  |  +3    |
+--------------------------------------------------------------------+
| TTHW                 | 2-3 min (est.) | blocked (~20+ min workaround) |
| Competitive Rank     | Competitive (target)                          |
| Magical Moment       | designed via existing guard messages + anchors|
| Product Type         | Claude Code skill suite + CLI helpers         |
| Mode                 | POLISH                                        |
| Overall DX           |  7/10  |  4/10  |  +3    |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (upgrade fixes it; no restart, DX-3)   |
| Learn by Doing     | covered (copy-paste recovery, cookbook)        |
| Fight Uncertainty  | covered (DX-1, DX-4, DX-10)                    |
| Opinionated + Escape Hatches | partial (B2 opt-out pending UC2; guard override pending UC1) |
| Code in Context    | covered (runnable fallbacks)                   |
| Magical Moments    | covered (first /autoplan just works)           |
+====================================================================+
```
DX Measurement stays at 6 (only below-7 dimension; not critical debt below 6). TTHW is under 10 minutes.

**TTHW assessment.** Current: blocked for affected users; the reported workaround took ~20+ minutes to find (observed in the #3062 thread). Target: Competitive, 2-5 minutes from `/gstack-upgrade` to /autoplan Phase 1 entry on Claude Code latest, default settings, measured by DX-16.

**DX Implementation Checklist.**
```
[ ] Recovery TTHW (upgrade -> Phase 1) measured under 5 minutes (DX-16)
[ ] Upgrade is one command; no restart needed (DX-3)
[ ] First /autoplan after upgrade enters Phase 1 without a denial (CEO-1, CEO-24)
[ ] Every guard denial: problem + cause + fix + runnable fallback + anchor (DX-1)
[ ] Every user-facing helper mention is a runnable absolute path (DX-2)
[ ] gstack-post synopsis, exit codes and confirm flow implemented and tested (DX-6)
[ ] Probe subcommands consistently named, help, exit 64, --model precedence (DX-7)
[ ] Doctor rows ok/warn/not configured/fail; only fail exits non-zero (DX-8)
[ ] Sync status table drives attention lines and tests (DX-4); skip reversible (DX-5)
[ ] Pre-push lines: rule, file, line, fix; partial history; allowlist (DX-9, DX-17)
[ ] Docs touchpoints updated (DX-12); classifier contract documented (DX-11)
[ ] Deprecation line and compatibility window for sourced probe (DX-7, DX-18)
[ ] Windows coverage or explicit non-support for new helpers (DX-15)
[ ] Changelog sections per symptom with copy-paste recovery (DX-12)
```

**NOT in scope (DX).** Doctor `--json` (deferred, DX POLISH adds no surfaces; pending TODOS.md write); A3 bound env overrides (rejected: partial-history rule covers large repos); timed novice install journey (deferred: install is not changed by this wave; pending TODOS.md write); recurring DX measurement owner (not proposed).

**What already exists (DX).** `docs/autoplan-guard-troubleshooting.md` and the `lib/gate-outcomes.ts` anchor convention (reused by DX-1); `./setup --status` (linked by DX-8); `bin/gstack-paths` (DX-2 lookups); `gstack-brain-sync --status`/`--skip-file` (extended by DX-4/DX-5); `scripts/resolvers/redact-doc.ts` per-finding acknowledgment (DX-6 keeps its semantics); the curated Windows subset (DX-15); Claude Code's own `claude doctor` as the naming model.

Pending TODOS.md writes (DX): doctor `--json` output; timed full novice install journey (Codex DX #8).

### Phase 2.5 DX review: Implementation Tasks

- [ ] **DX-T1 (P1, human: ~4h / CC: ~30min)** — guard docs — Rewrite autoplan guard troubleshooting page with per-code anchors and runnable fallbacks (DX-1)
  - Surfaced by: Codex DX #6; Claude DX docs high
  - Files: docs/autoplan-guard-troubleshooting.md, autoplan/bin/phase-publication-hook.ts
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T2 (P1, human: ~2h / CC: ~15min)** — helper paths — Absolute helper paths in attention lines, doctor, issue template, changelog (DX-2)
  - Surfaced by: Claude DX PATH high
  - Files: bin/gstack-skill-start, .github/ISSUE_TEMPLATE
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T3 (P1, human: ~2h / CC: ~15min)** — upgrade — Old-template close replay fixture and release-note upgrade text (DX-3)
  - Surfaced by: Claude DX in-flight session
  - Files: test/autoplan-publication-guard.test.ts, CHANGELOG.md
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T4 (P1, human: ~4h / CC: ~30min)** — artifacts sync — Status table driving attention lines and tests; --unskip-file (DX-4, DX-5)
  - Surfaced by: Both DX voices
  - Files: bin/gstack-brain-sync, bin/gstack-skill-start, test/brain-sync.test.ts
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T5 (P2, human: ~4h / CC: ~30min)** — gstack-post — Synopsis, exit codes, --confirm bound to exact bytes (DX-6)
  - Surfaced by: Both DX voices high
  - Files: bin/gstack-post, test/gstack-post.test.ts
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T6 (P2, human: ~4h / CC: ~30min)** — codex probe — Verb-first subcommands, help, exit 64, --model precedence, deprecation line, compat window (DX-7, DX-18)
  - Surfaced by: Codex DX #2/#3
  - Files: bin/gstack-codex-probe, test/codex-model-probe.test.ts
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T7 (P2, human: ~2h / CC: ~15min)** — doctor — Row states and setup --status link (DX-8)
  - Surfaced by: Codex DX #5
  - Files: bin/gstack-doctor, setup
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T8 (P1, human: ~3h / CC: ~20min)** — pre-push — Partial history, fix lines, per-email allowlist (DX-9, DX-17)
  - Surfaced by: Claude DX escape hatch
  - Files: bin/gstack-redact-prepush, test/redact-prepush.test.ts
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T9 (P2, human: ~1h / CC: ~10min)** — ship Greptile — Signal, push and wait status lines (DX-10)
  - Surfaced by: Claude DX B2 high
  - Files: ship/sections/greptile.md.tmpl
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T10 (P2, human: ~2h / CC: ~15min)** — outside voice — Classifier contract: tags and severity words, untagged = unverified, documented (DX-11)
  - Surfaced by: Both CEO and DX Codex runs printed clean
  - Files: lib/outside-review-result.ts, docs/troubleshooting.md
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T11 (P2, human: ~3h / CC: ~20min)** — docs — Documentation touchpoints and per-symptom changelog recovery (DX-12)
  - Surfaced by: Claude DX docs
  - Files: CHANGELOG.md, README.md, docs/troubleshooting.md
  - Verify: tests named in the cited DX obligation
- [ ] **DX-T12 (P2, human: ~3h / CC: ~20min)** — tests — No-op prompt check, guard log trim, Windows subset, recovery TTHW record (DX-13..16)
  - Surfaced by: Claude DX medium
  - Files: test/helpers/pty/launch.ts, scripts/lib/windows-curation.ts
  - Verify: tests named in the cited DX obligation

**DX accepted obligations.**

<!-- autoplan-accepted:dx -->
- DX-1 (guard troubleshooting page is a deliverable). `docs/autoplan-guard-troubleshooting.md` is rewritten with the guard changes: one anchor per CEO-3 reason code; the "Retry denials" section becomes CEO-3's dispositions (no "retry the same tool" for `identity` or `malformed`); the `too_large` section matches the bounded reader; the "no environment variable turns the guard off" line stays unless the user changes it at the gate. Every denial message ends with its anchor URL and prints the fallback as runnable commands (`/plan-ceo-review`, then `/plan-devex-review`, then `/plan-eng-review`; or `/context-save`, a new session, `/context-restore`, then `/autoplan <plan path>`). The `model` or extra-key denial says that a model override is not allowed for /autoplan reviewer dispatch. `docs/troubleshooting.md` stops teaching the sourced probe once B3 ships. CEO-3's free test also asserts that every code has an anchor and every denial string cites one.
- DX-2 (runnable paths). Every user-facing mention of a gstack helper (the `ARTIFACTS_SYNC:` attention lines, doctor's fix lines, the bug-report issue template, CHANGELOG recovery steps, denial fallbacks) prints the absolute path resolved from the install root, not a bare `gstack-*` name; the issue template gives the Claude Code path plus a `gstack-paths` lookup for other hosts. A free test asserts that rendered attention lines and the template contain no bare `gstack-` command.
- DX-3 (upgrade in place). Release notes say an upgrade needs no restart: an in-flight /autoplan session may get at most one publish-separately denial, which names the exact fix, and `CLAUDE_CODE_FORK_SUBAGENT=false` is no longer needed (harmless if kept). A replay fixture runs an old-template close sequence (report and next driver `Read` in one message) against the new hook and shows recovery after the denial without a restart.
- DX-4 (one sync status table). The plan's three staleness predicates are replaced by one table in `bin/gstack-brain-sync`'s usage header and the docs: `held` (scanner hold, held count), `blocked` (re-scan still flags), `push_failed`, `error`, stale-push (no push for 24 hours while the drain's `drainable` count is above zero), stale-drain (`last_drain_at` older than 24 hours while the queue directory holds records), each with its trigger, exact fixed attention-line text and fix command; `ok` and `idle` print no attention line. The skill-start tests are generated from that table.
- DX-5 (skip is permanent and reversible). `held` entries and the docs say `--skip-file` permanently excludes the path from future syncs, and a new `gstack-brain-sync --unskip-file <path>` reverses it. Each held group lists its blocking path and its held dependents. A test unskips a path and shows normal syncing resumes without publishing a partial group.
- DX-6 (`gstack-post` interface). Synopsis: `gstack-post {pr-comment|issue-comment|reply|pr-title|pr-body} <target> --body-file <file> [--host github|gitlab] [--confirm <rule-id>...]`; the host is detected from the remote unless `--host` is given. Exit codes: 0 posted; 1 HIGH finding refused; 2 MEDIUM findings need confirmation, printed on stdout as `RULE: <id> LINE: <n>` lines; 3 `gh`/`glab` failed. `--confirm` must name exactly the rule ids returned for those bytes; the helper re-scans every call, so changed bytes need a fresh confirmation and a HIGH finding is always refused. Tests: refusal then confirmation then post; changed content after confirmation re-prompts; HIGH refused even with `--confirm`.
- DX-7 (probe subcommand naming and help). Subcommands use one verb-first order: `select-model`, `check-auth`, `show-sandbox`, `check-sandbox`, `probe-model`, `check-version`, `show-first-use-notice`, `run-with-timeout`, `log-event`, `log-hang`, plus `help`; an unknown subcommand prints usage to stderr and exits 64. `select-model <exec|review> [--model <id>]` keeps today's precedence (per-request model over environment over config) and provenance, and the same model is used for probing and dispatch. While sourcing is still supported, sourcing prints one stderr line naming the deprecation and `/gstack-upgrade`.
- DX-8 (doctor result states). Each `gstack-doctor` row is `ok`, `warn`, `not configured` or `fail`; only `fail` makes the exit code non-zero. Intentionally absent Codex, disabled artifacts sync, an unbuilt optional browser and "not probed" are `not configured` or `warn` with the affected features named. Doctor's install row reuses the `./setup --status` check, and `./setup --status` ends with the absolute path to `gstack-doctor`.
- DX-9 (A3 partial history and fix lines). Hitting the 50,000-commit cap uses the partial author set; only an error or the 5-second timeout passes nothing, and either case prints one line saying existing-email suppression was limited for this push. Each MEDIUM line names rule id, file and line and a fix (remove the value, or allow it per DX-17).
- DX-10 (B2 says what it is doing). Before the early push, /ship prints the Greptile signal it used (config folder, `greptile.json`, or a Greptile comment within the last 90 days; older comments do not count), that it will push and open a draft now, and the wait cap; during the wait it prints progress. These lines apply whether B2 ends up default or opt-in (UC2).
- DX-11 (CEO-28 contract chosen). The classifier recognizes both `[P0]`-`[P3]` tags and severity words (`critical`, `high` blocking; `medium`, `low` non-blocking); a review with neither tags, severity words nor an explicit no-findings statement is `unverified`, never `clean`. The behavior is documented in `docs/troubleshooting.md` next to the gate outcomes.
- DX-12 (documentation touchpoints). The PR updates: CHANGELOG sections per symptom with copy-paste recovery ("If /autoplan denied every reviewer on Claude Code 2.1.29x", "If the pre-push hook warned on your own email", "If artifacts sync stopped pushing"); the guard troubleshooting page (DX-1); a README troubleshooting entry pointing at doctor; `gstack-brain-sync` usage (held, `--status` `held`, skip and unskip); the bug-report issue template; the browse cookbook (CEO-10); `gstack-post` usage; `docs/troubleshooting.md` (probe, classifier).
- DX-13 (no-op never prompts). The CEO-5/CEO-24 PTY runs assert that `: autoplan-published <phase>` runs without a permission prompt in the foreground session and, when driven, the `--bg` session.
- DX-14 (guard log bounded). `autoplan-guard.jsonl` keeps the last 1,000 lines (older lines are dropped on write); a free test covers the trim.
- DX-15 (Windows coverage of new helpers). `gstack-post`, `gstack-doctor` and the probe subcommands are added to the curated Windows free subset, or the PR names each one as not supported on native Windows yet.
- DX-16 (recovery TTHW measured). The CEO-24 foreground PTY run records the upgrade duration and the time from `/autoplan` invocation to Phase 1 entry; the PR reports them against the Competitive target (2-5 minutes for upgrade plus Phase 1 entry).
- DX-17 (pre-push email allowlist, taste). `git config --add gstack.redact.allowEmail <address>` allows that address for MEDIUM `pii.email` findings only; it never affects HIGH findings or other rules, and the MEDIUM fix line names it. Paired controls: an allowed address does not flag, a different address still flags, and a HIGH secret next to an allowed address still blocks.
- DX-18 (B3 compatibility window, taste). Sourcing stays supported for at least one release and at least 14 days, whichever is later; the CHANGELOG names the release that removes it, and the deprecation line (DX-7) appears from the first release.
<!-- /autoplan-accepted:dx -->

### Phase 2.5 close

DX close packet `/home/user/.gstack/projects/garrytan-gstack/autoplan-dx-j9q1uq/close-packet.md` (199 lines): lines 140-199 read directly, lines 1-139 byte-identical to the verified CEO packet apart from the binding line; report published. DX tasks JSONL: `/home/user/.gstack/projects/garrytan-gstack/tasks-devex-review-20261007-160952.jsonl` (12 tasks).

### Phase 3 Eng review

Eng methodology `/home/user/.gstack/projects/garrytan-gstack/autoplan-eng-methodology-Ed0kui/methodology.md` (2228 lines) read through EOF: 1-103, 427-1486 and 1741-2228 read directly; 104-426 (shared preamble) diffed against the CEO preamble (51 differing lines, all scope-gate and wording variants of the same rules); 1487-1740 (skip-listed outside voice) loaded only. Scope gate: target is this plan (named by the parent). Mode: FULL_REVIEW.

**Step 0: Scope Challenge (grounded in code).**
- What already solves each sub-problem: see CEO 0B and DX "What already exists"; additionally `_gstack_codex_timeout_wrapper` (B3 timeout supervisor), `pushTarget()`/`remotesExclusionArgs()` in `bin/gstack-redact-prepush:96-114` (A3 history scope), `autoplanReadRange` dedup handling (`phase-publication-hook.ts:267-286`), `test/ci-image-tag-binding.test.ts` (pin bump).
- Complexity check: about 45 changed files (estimate) and 4 new modules/commands (`lib/claude-journal-records.ts`, guard reason module, `bin/gstack-post`, `bin/gstack-doctor`), so the gate trips. Feature cuts: none (override: never reduce). Structure: original arrangement with two smaller-module moves inside it (reason table and record extraction out of their 600-line owners, ENG-17), which preserves every approved feature and fix. Scope record: feature answers none; structure A (original with module split, auto-decided P5); accepted scope as-is; pending remedies UC1, UC2.
- Search check: Claude Code hooks docs and claude-code#100051 (payload over journal for the current call, [Layer 3]); Greptile draft behavior docs ([Layer 1]).
- TODOS cross-reference: this plan closes seven "Oct 6 fix-wave follow-ups" entries conditionally (CEO-16); nothing in TODOS.md blocks it.
- Distribution check: two new executables (`gstack-post`, `gstack-doctor`) ship through `./setup` like other `bin/` helpers; Windows coverage by DX-15.
- Retrospective: the guard and brain-sync paths have been touched by five fix waves since September (#2999, #3017, #3023, #3025, #3057); no reverts, but repeated repair of the same boundaries.
Scope Challenge result: scope accepted as-is.

**Claude SUBAGENT (eng — independent review): completed.** `INPUT: eng 2f0f254d…b103` (hash matches). 12 findings plus 5 test and 4 security items and 5 consistency items. High: E1 background dispatch plus a typed turn disarms the guard (`disarmed()`, `phase-publication-hook.ts:336`); E2 the invocation window loses dedup witnesses (`:267-286`); E3 pass two is bounded by time, not memory; E7 the payload path assumes one message of lag and can fail open or loop; T1 missing fixtures for E1/E2. Medium: E4 per-call full rescan (index cache), E5 coupling map does not exist, E8 allowlist outage class, E9 history scope for url/unknown targets, E12 log race, T2 padding validity, T3 classifier false positives, S1 canary supply chain, S2 flag injection, S3 early push, C1 conflicting subcommand names, C4 pin-bump reds can hold Tier 1. Low: E6, E10, E11, T4, T5, S4, C2, C3, C5.

**Codex SAYS (eng — architecture challenge): completed, `OUTSIDE_STATUS: completed provider=codex host=claude`, `VERDICT: findings`, `FINDINGS: P1`.** 8 findings: [P1] same-phase batches still timing-dependent on the journal path (`:476`); [P1] a 10-minute age does not prove an index lock is abandoned (skill-start merge `gstack-skill-start:326`, artifacts-init `:444` run outside the drain lock); [P1] rule-id confirmation cannot bind exact bytes (`redact-doc.ts:79`); [P1] holding coupled files does not make publication atomic (`gstack-decision-log:84` enqueues only the log); [P1] a failed commit still finalizes the queue as `idle` (`gstack-brain-sync:763`); [P2] A2 bounds record size, not total memory or evaluation cost (quadratic filters at `:441`, `:462`); [P1] the long-session PTY case would be observed by the 32 MiB counting reader (`claude-public-transcript.ts:349`, `pty/runners/counting.ts:476`); [P2] A3 line numbers are slice-relative (`gstack-redact-prepush:310,369`). Recommendation: "Revise before implementation because batch handling, sync transactions, posting confirmations, and long-session validation still contain concrete correctness gaps."

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               No      No     CONFIRMED (guard window/bg dispatch, A4 coupling)
  2. Test coverage sufficient?         No      No     CONFIRMED (bg/dedup fixtures, PTY observer, batch permutations)
  3. Performance risks addressed?      No      No     CONFIRMED (retained data, per-call rescans)
  4. Security threats covered?         No      No     CONFIRMED (flag injection, confirm binding, canary supply chain, history scope)
  5. Error paths handled?              No      No     CONFIRMED (payload preconditions, commit failure, line mapping, log race)
  6. Deployment risk manageable?       Risk    OK     DISAGREE -> taste T10 (pin-bump reds: quarantine vs repair in wave)
CONFIRMED = completed native subagent + completed Codex.
```
Single-voice critical findings: none rated critical; Codex's five [P1] items and Claude's four highs are all accepted below.

**Section 1: Architecture.**
```
  Claude Code hook payload ----------------------------+
  Claude Code journal (.jsonl, append-only, may lag)   |
        |                                              v
        v                                   autoplan/bin/phase-publication-hook.ts
  lib/claude-journal-records.ts (NEW) <---- [pass 1 index: ids, parents, kinds, Read args, Bash cmds]
        ^                                   [pass 2 window: classes the evaluator reads (ENG-5)]
        |                                   [payload path (CEO-1, ENG-2/3), batch rule, allowlist]
  readPlanCountTranscript (tests, PTY)      +--> guard-reasons module (NEW, ENG-17) --> docs anchors (DX-1)
                                            +--> analytics/autoplan-guard.jsonl (CEO-12, ENG-15) --> gstack-doctor (NEW)
                                            +--> bin/gstack-autoplan-snapshot.ts manifests (unchanged)
  bin/gstack-redact-prepush --(selfEmail, repoPublicEmails, line map ENG-8)--> lib/redact-engine.ts (unchanged)
  bin/gstack-brain-sync --(shared lock, groups, held/error, ENG-7)--> skill-start ARTIFACTS_SYNC (DX-4 table)
       ^ shared lock also taken by gstack-skill-start merge, artifacts-init, brain-restore, gbrain-source-wireup
  ship/sections/greptile.md.tmpl --(early PR, trigger, completion poll)--> bin/gstack-post (NEW) --> gstack-redact --> gh/glab
  generated skills --> bin/gstack-codex-probe <subcommand> (B3, DX-7/ENG-12)
  evals-periodic.yml daily --> autoplan-schema-canary (NEW) --> latest Claude Code (ENG-11)
```
Findings: [P1] (9/10) `phase-publication-hook.ts:336` `disarmed()` ends the invocation on any typed turn after `end_turn`; background dispatch makes that reachable mid-phase (ENG-1). [P1] (8/10) Codex/Claude: A4 group publication is not atomic and the lock rule cannot prove abandonment (ENG-7). [P2] (7/10) one realistic production failure per integration: Claude Code adds an Agent schema default (ENG-14 names it), Greptile never posts (CEO-8 unavailable path), a commit hook rejects the sync commit (ENG-7c). Dispositions: accepted (ENG-1, ENG-7, ENG-14).

**Section 2: Code quality.** [P2] (8/10) `bin/gstack-codex-probe` subcommand names conflict between CEO-9 and DX-7 (ENG-12). [P2] (7/10) guard reason codes would add 51 call-site edits to a 633-line file; move to a module (ENG-17). [P2] (7/10) `bin/gstack-brain-sync:727,735,763` swallow `git add`/`reset`/`commit` failures (ENG-7c plus A4). [P3] (6/10) shared-code: `lib/claude-journal-records.ts` has two verified callers (`readOwnedClaudePublicTranscript` at `lib/claude-public-transcript.ts:554` and `readPlanCountTranscript` at `:322`), net savings expected once extraction is shared; Python scanner duplication with `lib/redact-patterns.ts` stays deferred (X8, cross-language). Stale diagrams: the hook's flush comment (`:479-481`) and the causal-order comment (`claude-public-transcript.ts:207-208`) must change with CEO-1/CEO-2. Dispositions: accepted.

**Section 3: Test review.** Framework: bun test (CLAUDE.md "Testing"; `bun run test` via `scripts/test-free-shards.ts`). Existing relevant tests read for mapping: `test/autoplan-publication-guard.test.ts` (1478 lines), `test/brain-sync.test.ts` (998), `test/redact-prepush-*.test.ts` (4 files), `test/codex-model-probe.test.ts`, `test/outside-review-result.test.ts`, `test/ship-greptile-pr-check.test.ts`, `test/gstack-skill-start.test.ts`, `test/ci-image-cli-pin.test.ts`, `test/skill-e2e-autoplan-journal-drift.test.ts`, `test/skill-e2e-autoplan-dual-voice.test.ts` (SDK-headless; does not exercise flush lag).
```
CODE PATHS                                                   USER FLOWS
[+] autoplan/bin/phase-publication-hook.ts                   [+] /autoplan on CC 2.1.292 (default settings)
  ├── journal path, exact compare minus run_in_background    ├── [GAP] [→E2E] upgrade -> Phase 1 -> one transition (ENG-18)
  │   ├── [★★★ TESTED] changed prompt/description denied      ├── [GAP] [→E2E] --bg via claude attach (CEO-5)
  │   └── [GAP] Cause A schema strip fixture                  └── [GAP] typed message while reviewer runs (ENG-1)
  ├── payload path (CEO-1, ENG-2)                            [+] long session > 100 MiB
  │   ├── [GAP] lone Read/Agent allowed                       └── [GAP] [→E2E] padded journal resume, observer = guard log (ENG-6)
  │   ├── [GAP] multi-message lag -> bounded wait/deny       [+] push with author emails
  │   └── [GAP] publish-separately twice -> fallback          ├── [★★ TESTED] HIGH blocks, MEDIUM counts (redact-prepush-hook)
  ├── batch rule both paths (ENG-3)                           └── [GAP] own/known email silent; unknown flags with line (ENG-8)
  │   └── [GAP] permutations + cross-phase negative          [+] artifacts sync
  ├── messageId publication rule                              ├── [★★ TESTED] blocked on secret (brain-sync)
  │   ├── [GAP] same message denied (flushed and lagging)     ├── [GAP] held file + clean push + attention line (DX-4)
  │   └── [GAP] partial flush denied                          ├── [GAP] commit hook rejects -> error, queue kept (ENG-7c)
  ├── allowlist + unknown key code (ENG-14)                   └── [GAP] drain never runs -> stale-drain line
  │   └── [GAP]                                              [+] /ship with Greptile
  ├── disarm rule under bg dispatch (ENG-1) [GAP]             ├── [★★ TESTED] no-PR skip (ship-greptile-pr-check)
  └── reason codes + anchors (CEO-3, DX-1) [GAP]              └── [GAP] draft trigger / completion poll / timeout unavailable
[+] owned reader (CEO-2, ENG-4/5)                            [+] gstack-post
  ├── [★★ TESTED] too_large at cap via seam                   └── [GAP] token confirm, flag injection (ENG-9)
  ├── [GAP] append during read; prefix rewrite               [+] probe subcommands
  ├── [GAP] window anchor: Skill-tool start, reused init      └── [GAP] bash/zsh, exit 64, --model, timeout 124 (ENG-12)
  ├── [GAP] dedup witness before window (ENG-4)
  └── [GAP] retained-data bound + many-small-records bench
LLM integration: [→EVAL] phase-close/phase sections, foreground note, aside rules, brain-sync preamble wording (CEO-18 checks, then paid cases)
COVERAGE: 4/29 paths tested today (14%) | GAPS: 25 (5 E2E, prompt evals per CEO-18)
QUALITY: ★★★:1 ★★:3
```
Every GAP above maps to a named test in the CEO, DX or ENG obligations, each with a value card in the test plan artifact `/home/user/.gstack/projects/garrytan-gstack/user-garrytan-followup-wave-oct7-eng-review-test-plan-20261007-161238.md`. Regression rule: the existing pending-Read tests and the `reused:true` re-arm tests (`autoplan-publication-guard.test.ts:736,1062`) are kept as controls (CRITICAL regression contract carried from CEO-2). LLM/eval scope: template edits run `test/parity-suite.test.ts`, prompt-size checks and goldens, then the autoplan paid case (ENG-18), `autoplan-journal-drift`, the full gate tier on the new pin (CEO-4) and `autoplan-dual-voice`. Tests to retire: none.

**Section 4: Performance.** [P2] (8/10) per-guarded-call full parse at 120 MiB times 20-40 calls per run (measured current reader ~0.45-0.5 s and ~684 MiB RSS per call on a 5.7k-record synthetic); ENG-5 bounds retained data and removes per-tool rescans, and the spike decides on an index cache. [P2] (7/10) A4 scanner attribution would spawn one git process per queued path (1,390 in PR #3055's case); one-pass split (ENG-7d). [P3] (6/10) A3 history read bounded to 50,000 commits and 5 s. No database or N+1 concerns.

**Failure modes (critical gaps).**
```
  CODEPATH              | FAILURE MODE                         | RESCUED? | TEST? | USER SEES?            | CRITICAL?
  guard disarm          | typed turn during bg reviewer        | N->Y     | N->Y  | silent allow (before) | was CRITICAL, fixed by ENG-1
  brain-sync commit     | commit hook/lock failure             | N->Y     | N->Y  | silent "idle" (before)| was CRITICAL, fixed by ENG-7c
  guard payload path    | multi-message lag                    | Y        | Y     | named deny + fallback | no
  brain-sync lock       | live writer's old index.lock         | Y        | Y     | obstruction reported  | no
  gstack-post           | same-rule different bytes            | Y        | Y     | new token required    | no
  pre-push A3           | slice-relative line numbers          | Y        | Y     | correct file line     | no
  PTY long-session case | observer hits 32 MiB cap             | Y        | Y     | guard-log witness     | no
```
Critical gaps flagged: 2, both resolved by accepted obligations; 0 remain.

**Worktree parallelization strategy.**

| Step | Modules touched | Depends on |
|------|----------------|------------|
| Guard (A1, A2, CEO-1/2/3/12, ENG-1..6/14/15/17) | autoplan/bin, lib (transcript, records), autoplan/sections, test | — |
| Pin + canaries (CEO-4/13/15, ENG-11/18/19/21) | .github, test/helpers/pty, test | Guard |
| Pre-push (A3, CEO-7, ENG-8, DX-9/17) | bin (redact-prepush), test | — |
| Sync (A4, CEO-14/17/27, ENG-7/13, DX-4/5) | bin (brain-sync, skill-start, artifacts-init, brain-restore), scripts/resolvers/preamble | — |
| Probe + post + doctor (B3/B4/B5, ENG-9/12, DX-6/7/8) | bin, scripts/resolvers | — |
| Ship Greptile (B2, CEO-8, ENG-20, DX-10) | ship | Probe + post (gstack-post) |
| Context-restore, browse, classifier, credits (B1, B6, B7, CEO-28) | context-*, scripts/resolvers/aside.ts, lib/outside-review-result.ts, CHANGELOG | — |

Parallel lanes: Lane A: Guard -> Pin + canaries. Lane B: Pre-push. Lane C: Sync. Lane D: Probe + post + doctor -> Ship Greptile. Lane E: Context-restore, browse, classifier. Execution order: launch A, B, C, D, E; merge B, C, E; merge A then run the pin gate; merge D. Release files (CHANGELOG, VERSION, TODOS.md) last. Conflict flags: `scripts/resolvers/constants.ts` (CEO-20 in A, B3 in D), `bin/gstack-skill-start` (C and the doctor link in D), `test/helpers/touchfiles-data.ts` (A and E).

**NOT in scope (eng).** Supported-hook-event state machine (no supported event carries the published text; CEO-30 asks upstream); quarantining unrelated pin-bump reds (taste T10, repaired instead); a persisted index cache unless the spike shows the rescan misses budget (ENG-5).

**What already exists (eng).** `_gstack_codex_timeout_wrapper` (reused by ENG-12), `pushTarget()`/`remotesExclusionArgs()` (reused by ENG-8), the hook's existing pending-Read path (generalized), `autoplanReadRange` (kept; ENG-4 preserves its witness), the existing drain lock (extended to all writers by ENG-7), `test/ci-image-tag-binding.test.ts` (ENG-21), `GSTACK_TRANSCRIPT_TEST_MAX_BYTES` seam (reused).

**TODOS.md updates collected from every phase (pending writes; this run edits no repository file except the plan).** X7 doctor guard check against a named journal (CEO, P3); X8 brain-sync scanner unification with `lib/redact-engine.ts` (CEO, P3); doctor `--json` (DX, P3); timed full novice install journey (DX, P3); X10 `--bg` preflight warning, only if CEO-5 reopens it (CEO, conditional); removal of the closed "Oct 6 fix-wave follow-ups" entries per CEO-16.

**Completion summary (eng).**
- Step 0: Scope Challenge — scope accepted as-is (structure: original arrangement with module split)
- Architecture Review: 3 issues found
- Code Quality Review: 4 issues found
- Test Review: diagram produced, 25 gaps identified (all mapped to named tests)
- Performance Review: 3 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 6 items collected (pending writes)
- Failure modes: 2 critical gaps flagged (both resolved by ENG-1 and ENG-7)
- Unresolved decisions: 2 (UC1, UC2 at the final gate)
- Outside voice: Codex gpt-6-astra, completed
- Parallelization: 5 lanes, 4 parallel / 1 sequential dependency chain
- Lake Score: N/A (no coverage-scored questions were asked)

### Phase 3 Eng review: Implementation Tasks

- [ ] **ENG-T1 (P1, human: ~4h / CC: ~30min)** — autoplan guard — Keep invocation armed during background reviewer dispatch; replay fixtures (ENG-1)
  - Surfaced by: Codex/Claude eng; phase-publication-hook.ts:336
  - Files: autoplan/bin/phase-publication-hook.ts, test/autoplan-publication-guard.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T2 (P1, human: ~6h / CC: ~45min)** — autoplan guard — Payload-path preconditions, bounded lag wait, shared batch rule on both paths (ENG-2, ENG-3)
  - Surfaced by: Claude E7; Codex P1 batch
  - Files: autoplan/bin/phase-publication-hook.ts, test/autoplan-publication-guard.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T3 (P1, human: ~1 day / CC: ~1.5h)** — journal reader — Read-args index for dedup witnesses; class-limited pass two; tool-id indexed evaluation; retained bound; spike vs index cache (ENG-4, ENG-5)
  - Surfaced by: Claude E2/E3/E4; Codex P2 memory
  - Files: lib/claude-journal-records.ts, lib/claude-public-transcript.ts, scripts/measure-journal-read.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T4 (P1, human: ~3h / CC: ~20min)** — long session — Guard-log observer for the padded-journal PTY case, proven on the fixture first (ENG-6)
  - Surfaced by: Codex P1 observer cap
  - Files: test/skill-e2e-autoplan-long-session.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T5 (P1, human: ~1 day / CC: ~1.5h)** — artifacts sync — Shared drain lock for all writers, explicit group map with consistent generation, commit failure keeps queue, one-pass attribution (ENG-7)
  - Surfaced by: Codex P1 x3; Claude E5/E6
  - Files: bin/gstack-brain-sync, bin/gstack-skill-start, bin/gstack-artifacts-init, bin/gstack-brain-restore, bin/gstack-gbrain-source-wireup, test/brain-sync.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T6 (P1, human: ~4h / CC: ~30min)** — pre-push — Source-line mapping, history scope for url/unknown targets, mailmap emails (ENG-8)
  - Surfaced by: Codex P2 lines; Claude E9
  - Files: bin/gstack-redact-prepush, test/redact-prepush-scan-range.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T7 (P2, human: ~3h / CC: ~20min)** — gstack-post — Byte-digest confirmation token and flag-injection-safe argv (ENG-9)
  - Surfaced by: Codex P1; Claude S2/T4
  - Files: bin/gstack-post, test/gstack-post.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T8 (P2, human: ~2h / CC: ~15min)** — outside voice — Label-position severity matching and stored-output panel incl. this run's three outputs (ENG-10)
  - Surfaced by: Claude T3
  - Files: lib/outside-review-result.ts, test/outside-review-result.test.ts, test/fixtures
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T9 (P1, human: ~2h / CC: ~15min)** — canary — Supply-chain hardening and stated one-day alert latency (ENG-11)
  - Surfaced by: Claude S1/C3
  - Files: .github/workflows/evals-periodic.yml, test/skill-e2e-autoplan-schema-canary.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T10 (P2, human: ~2h / CC: ~15min)** — codex probe — DX-7 names, supervised run-with-timeout, stdin and 124 tests (ENG-12)
  - Surfaced by: Claude C1/T5
  - Files: bin/gstack-codex-probe, test/codex-model-probe.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T11 (P2, human: ~3h / CC: ~20min)** — guard module — Reason-code module, unknown-key code, append-only schema log with threshold trim (ENG-14, ENG-15, ENG-17)
  - Surfaced by: Claude C5/E8/E12
  - Files: autoplan/bin/phase-publication-hook.ts, autoplan/bin/guard-reasons.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T12 (P2, human: ~1h / CC: ~10min)** — context-restore — Scan cap, home-directory filter, generic-title stoplist (ENG-16)
  - Surfaced by: Claude E10/E11
  - Files: context-restore/SKILL.md.tmpl, bin/gstack-slug
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T13 (P1, human: ~1 day / CC: ~1h)** — CI pin — Automated Phase 1 + one-transition PTY case, manual every-transition session, unrelated reds repaired once, image tag binding (ENG-18, ENG-19, ENG-21)
  - Surfaced by: Taste T9/T10; Claude C4
  - Files: .github/docker/Dockerfile.ci, test/helpers/pty/launch.ts, test/ci-image-tag-binding.test.ts
  - Verify: tests named in the cited ENG obligation and the test plan artifact
- [ ] **ENG-T14 (P2, human: ~1h / CC: ~10min)** — ship Greptile — Abort path leaves draft with a comment; public-repo consent if default-on (ENG-20)
  - Surfaced by: Claude S3
  - Files: ship/sections/greptile.md.tmpl
  - Verify: tests named in the cited ENG obligation and the test plan artifact

**Eng accepted obligations.**

<!-- autoplan-accepted:eng -->
- ENG-1 (background dispatch keeps the invocation armed). An `end_turn` while a reviewer `Agent` dispatched by this invocation has no completion record does not end the invocation, and a typed user turn during that window does not disarm the guard. Replay fixtures: background dispatch, `end_turn`, typed turn, next phase entry still requires the previous report. CEO-13's canary asserts the completion-notification record's `promptSource` and `isMeta` on the latest release, and the CEO-24 PTY session sends one typed message while a reviewer runs.
- ENG-2 (payload-path preconditions). The payload path runs only when every journaled `tool_use` has its result, except siblings with the last journaled `messageId`. When the newest journaled record is older than the assistant message before the current call (lag of more than one message), the hook waits up to 2 seconds for that record, then denies with a named journal-lag cause and the supported fallback. The same publish-separately cause seen twice in one invocation switches to the fallback text instead of repeating the instruction.
- ENG-3 (one batch rule on both paths; replaces CEO-1's payload-only sibling clause). Guarded calls in the same assistant message that target the same phase are one batch on the journal path and the payload path; a call targeting another phase still denies. Tests: fully flushed, partially flushed and missing-current batches, result-order permutations, and cross-phase negative controls.
- ENG-4 (dedup witnesses survive the window). The pass-one index records each `Read` tool_use's `file_path`, `offset` and `limit`; when a candidate Read's result is Claude Code's "file unchanged since your last Read" reply, the cited earlier record is loaded into pass two even if it predates the window. Fixture: two /autoplan runs in one session where the second driver Read is a dedup reply.
- ENG-5 (retained data and cost are bounded). Pass two keeps full content only for the record classes the evaluation reads: Bash results of init and checkpoint uses, results of candidate Reads, assistant text after the close Read, and mutation uses on the active plan; everything else stays index-only. Evaluation state is indexed by tool id and order, so no per-tool rescans. Retained data has a named bound; exceeding it is a hard denial naming an oversized invocation with the supported fallback. The 120 MiB acceptance journal puts most bytes inside the invocation window, and a second benchmark uses a large current invocation of many small records. CEO-25's spike compares the full rescan with a pass-one index cache under the state root (keyed by device, inode, scanned size and a hash of the last 64 KiB before the cached offset); a backward tail read cannot prove `competing_root` or `cycle`, so it is not the comparison. The cache is adopted only if the full rescan misses CEO-2's 1 s budget (taste).
- ENG-6 (long-session observer; amends CEO-15). CEO-15's case observes the outcome through the CEO-12 guard decision log (decision path and allow for the Phase 1 entry), not the 32 MiB PTY counting reader, and a free test proves that observer on the oversized fixture before the paid run. Padding records pass the ownership checks (session id, cwd, uuid chain, before a real `compact_boundary`), and the case asserts the decision path and reason code.
- ENG-7 (A4 transactions; replaces CEO-17's lock clause and narrows CEO-27). (a) Every gstack writer to `$GSTACK_HOME` git state (the drain, the skill-start merge, `gstack-artifacts-init`, `gstack-brain-restore`, `gstack-gbrain-source-wireup`) takes the same drain lock; a stale `.git/index.lock` is removed only while this process holds that lock and the index lock is older than 10 minutes, otherwise the drain reports the obstruction and keeps the queue. (b) Coupled groups come from an explicit map in code, starting with `decisions.jsonl` and its active snapshot; the drain expands selection to the whole group and stages a consistent generation (snapshot matching the log it was built from, checked before staging); unlisted paths are independent. (c) A failed `git commit` is distinguished from a verified empty staged diff (`git diff --cached --quiet`); any other failure keeps the queue and writes status `error`. (d) Scanner hits are attributed by splitting one staged diff on its `diff --git` headers in the existing Python block, not by one git process per path. Tests: an old index lock while another writer holds the drain lock is left alone; clean update of a group; a concurrent writer; a rejecting commit hook; a commit failure after staging; 1,000 queued paths in one scanner pass.
- ENG-8 (A3 line mapping and history scope; amends CEO-7). Collection and chunking keep commit, path and source-line mappings from hunk headers, so each MEDIUM line points at the real file line; findings only in historical commits name the commit. For `url` and `unknown` push targets, `repoPublicEmails` uses only the remote sha's history (when present locally) and the pushed commits, never all remotes. Author and committer emails are read raw and mailmapped (`%ae %aE %ce %cE`). Suppressing third-party emails that appear in the pushed commits is documented as accepted (they become public with the push). Tests: separated hunks, a chunk boundary, content removed before the pushed tip, and an email present only in another remote's history still flags.
- ENG-9 (`gstack-post` confirmation and argument safety; replaces DX-6's rule-id confirmation). On exit 2 the helper prints a confirmation token: a digest of the exact bytes, destination, operation and findings; `--confirm <token>` posts only those bytes, which the helper reads once and sends as scanned. Values go to `gh`/`glab` in `--flag=<value>` form or after `--`, and `<target>` must be a number or a same-host URL. Tests: replacing one flagged email with another (same rule ids and lines) needs a new token; a title of `--repo evil/x` is posted as text.
- ENG-10 (classifier precision; refines DX-11). Severity words count only in label position (`Severity: High`, a leading `High:`, `**High**`, `High —` or a table cell), not inside words like "high-level". A panel of stored real Codex outputs keeps its current verdicts, and the three outputs from this /autoplan run are added as fixtures (CEO, DX: severity words without tags; eng: `[P1]` tags).
- ENG-11 (canary supply chain and latency). `autoplan-schema-canary` installs the latest Claude Code with `npm install --ignore-scripts`, runs `npm audit signatures` before use, uses a budget-capped key, and runs in a job without write tokens. Its alert latency is stated as at most one day after a release (daily run, red in the periodic report), replacing "within a week".
- ENG-12 (probe names and timeout supervisor). DX-7's subcommand names govern; CEO-9's contract maps onto them (`check-auth`, `show-sandbox`, `run-with-timeout`). `run-with-timeout` supervises the command with the existing gtimeout, timeout, then watchdog chain (not exec) and returns 124 on timeout. Tests: stdin passthrough and exit 124 on both the coreutils and the bash-watchdog branch.
- ENG-13 (attention-line paths). Attention lines never include artifact or status-message paths; the absolute install-root helper path from DX-2 is allowed, and the no-status-text test allows it.
- ENG-14 (unknown Agent key). A reviewer dispatch with a key outside the allowlist is denied with its own reason code and the hand-run fallback, and CEO-12's log records the unknown key names, never values.
- ENG-15 (guard log writes; refines DX-14). Lines are append-only and carry a `schema` field; trimming to the last 1,000 lines happens through a temporary file and rename only when the file exceeds 256 KiB, and losing a concurrent trim race is tolerated. Doctor's reason-code row filters on the schema.
- ENG-16 (B1 bounds). The below-cwd checkpoint scan reads at most the 200 newest checkpoints and, from `$HOME`, lists only projects under the cwd by recency. Generic titles (`wip`, `checkpoint`, `save`, `notes`, `todo`) never match on title alone; they need the ticket token.
- ENG-17 (guard module layout). Reason codes, denial text and anchors live in one module beside the hook (single source for DX-1's anchor test), the payload evaluation is its own function, and `autoplan/bin/phase-publication-hook.ts` stays under the 800-line owner-module limit.
- ENG-18 (live-run scope, taste; amends CEO-24). The automated paid PTY case uses a hermetic minimal plan and covers Phase 1 entry plus one phase transition within the ~10-minute eval budget (rule kind, one trial). The every-transition run from CEO-24 is one recorded manual PTY session on 2.1.292 attached to the PR.
- ENG-19 (pin-bump reds, taste). PTY or gate reds on the 2.1.292 pin that are unrelated to /autoplan are repaired in this wave (one repair round each, no retries or lowered thresholds); a case still red after that round is reported as a named red through the #3059 measure loop, and whether it holds the merge is Garry's call at ship time.
- ENG-20 (B2 abort path). If /ship stops after opening the early PR, it leaves the draft open with one comment saying /ship stopped and why; it never closes or force-pushes it. If UC2 keeps B2 on by default, the early push on a public repo asks once for consent.
- ENG-21 (image tag binding). The pin bump runs `test/ci-image-tag-binding.test.ts` and updates any workflow image reference it requires.
<!-- /autoplan-accepted:eng -->

### Phase 3 close and Phase 4 pre-gate verification

Eng close packet `/home/user/.gstack/projects/garrytan-gstack/autoplan-eng-tHG7jp/close-packet.md` (220 lines): lines 163-220 read directly, lines 1-162 byte-identical to the verified DX packet apart from the binding line; report published. Eng tasks JSONL: `/home/user/.gstack/projects/garrytan-gstack/tasks-eng-review-20261007-162630.jsonl` (14 tasks). Test plan: `/home/user/.gstack/projects/garrytan-gstack/user-garrytan-followup-wave-oct7-eng-review-test-plan-20261007-161238.md`.

Pre-gate verification (all present): CEO premise challenges, Sections 1-10 with Section 11 skipped, Error & Rescue and Failure Modes registries, NOT in scope, What already exists, dream state delta, Completion Summary, consensus table; DX scores for 8 dimensions, journey map, empathy narrative, TTHW assessment and target, DX Implementation Checklist, consensus table; Eng scope challenge, architecture diagram, codepath-to-test diagram, test plan on disk, NOT in scope, What already exists, failure modes with critical gaps, Completion Summary, consensus table. Voices: native and Codex completed in CEO, DX and Eng; Design skipped. Aggregated tasks: 43 (17 CEO, 12 DX, 14 Eng). Not done by instruction: the final gate question and review logs. Not done by host restriction: TODOS.md writes (collected as pending writes) and the plan-ceo/devex/eng terminal `## GSTACK REVIEW REPORT` blocks (skip-listed under /autoplan).

Cross-phase themes: (1) the guard's dependence on Claude Code's private journal and flush timing (CEO F2/F5 and Codex #2; DX advisory-mode note; Eng E1/E7 and Codex batch/observer findings); (2) B2's early push should be opt-in (CEO both voices, DX both voices, Eng S3); (3) live proof of P1 rather than fixtures (CEO-24/Codex #1, DX-16, Eng ENG-6/ENG-18); (4) A4 sync correctness beyond visibility (CEO Codex #3 and F7, DX status table, Eng ENG-7); (5) the outside-review classifier printed `VERDICT: clean` for severity-word reviews twice (CEO, DX), fixed by CEO-28/DX-11/ENG-10.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | Preamble | Do not apply gstack upgrade 1.91.29.0 → 1.91.33.0 mid-run | Mechanical | P6 | Keeps review skills fixed; parent provisioned this install | Upgrade now |
| 2 | Preamble | Leave telemetry and cross_project_learnings unchanged | Mechanical | P5 | Never change user settings on their behalf | Enable |
| 3 | CEO 0D | Approach A: targeted fixes plus CEO-1..3 corrections | Mechanical | P1, P5 | Keeps the publication guarantee; B removes enforcement on lagging sessions; C moves the dependency | B deny-only-on-proof, C new evidence source |
| 4 | CEO 0D | A2 streams a bounded read instead of raising the cap | Mechanical | P1, P4 | Oct 6 consensus; peak RSS measured at 5.7x journal size | Raise cap with full read |
| 5 | CEO 0E | Mode SELECTIVE EXPANSION | Mechanical | override | /autoplan override; one-PR rule | SCOPE REDUCTION (file count) |
| 6 | CEO 0G | Keep every Tier 1 and Tier 2 item | Mechanical | P1 | Never reduce a complete plan | Defer Tier 2 items |
| 7 | CEO 0A | CEO-1 payload path for Read and Agent plus publication flush rule | Mechanical | P1 | Cause B as written loops at phase transitions on lagging journals | Agent-only payload path |
| 8 | CEO 0A | CEO-2 append-tolerant prefix read | Mechanical | P1 | `changing` would deny long sessions, breaking P1 | Keep size-equality stability check |
| 9 | CEO 0A | CEO-3 denial inventory, P1 wording kept | Taste | P1, P6 | One real transient remains; wording question surfaced at gate | Rewrite P1 now |
| 10 | CEO 0A | CEO-4 full gate tier on the 2.1.292 pin | Mechanical | P1 | Dockerfile.ci rule for pin bumps | Autoplan cases only |
| 11 | CEO 0A | CEO-5 record `--bg` unverified if attach cannot be driven | Mechanical | P1 | Never claim unverified coverage | Claim P1 for `--bg` from fixtures |
| 12 | CEO 0G | X2/CEO-6 macOS measurement via CI runner | Mechanical | P1, P2 | Restores TODO acceptance | Linux only |
| 13 | CEO 0A | CEO-7 remote history from tracking refs, bounded | Mechanical | P1 | Zero sha on every new-branch push | `<remote sha>` only |
| 14 | CEO 0A | CEO-8 `@greptileai` trigger on drafts | Mechanical | P1 | Greptile skips drafts by default | Draft and wait |
| 15 | CEO 0A | CEO-9 keep zsh self-locate during compat release | Mechanical | P1 | Removing it re-breaks zsh sourcing | Remove now |
| 16 | CEO 0A | CEO-10 keep rule 1 tab consent | Mechanical | P1 | Plan text dropped consent the issue itself keeps | Attach without asking |
| 17 | CEO 0G | X1/CEO-11 #1743 credit | Mechanical | P2 | Same entry, same slip | Leave |
| 18 | CEO 0G | X3/CEO-12 denial log line | Mechanical | P2 | Same file and log | Skip |
| 19 | CEO 0G | X4/CEO-13 canary on latest Claude Code | Mechanical | P1, P2 | Root cause of #3062 was CI never seeing the version | Pin only |
| 20 | CEO 0G | X5 line number in MEDIUM summary (inside CEO-7) | Mechanical | P2 | Same line | Rule and file only |
| 21 | CEO 0G | X6/CEO-14 `--status` lists held paths | Mechanical | P2 | A4 points users there | Status JSON only |
| 22 | CEO 0G | X7 doctor guard check deferred | Mechanical | P3 | Design unclear | Add |
| 23 | CEO 0G | X8 scanner unification deferred | Mechanical | P3 | L effort, cross-language | Add |
| 24 | CEO 0G | X9 parsed-prefix cache skipped | Mechanical | P5 | Not the bottleneck; adds trust input | Add |
| 25 | CEO 0G | X10 bg preflight skipped | Mechanical | P4 | Superseded by CEO-1 | Add |
| 26 | CEO 0H spec 1 | CEO-1 Agent key allowlist in manifest; `description` control on journal path only | Mechanical | P1, P5 | Payload path has no second copy; `model` must stay denied | Claim description control on both paths |
| 27 | CEO 0H spec 1 | CEO-1 payload path on first ready read, no 2 s wait | Taste | P3, P5 | Lagging sessions never flush within the window (#100051); saves ~2 s per guarded call | Wait out the 2 s poll (plan text) |
| 28 | CEO 0H spec 1 | CEO-1 same-phase siblings allowed; flush via `scope` call | Mechanical | P5 | Explicit carrier for every transition incl. Phase 4 | Unnamed unguarded call |
| 29 | CEO 0H spec 1 | CEO-2 hook-only two-pass reader; 32 MiB per-record bound; 1 s / 256 MiB acceptance | Mechanical | P1, P5 | Leaves 35 batch callers untouched; no journal readable today becomes unreadable | Change shared reader; unbounded record size |
| 30 | CEO 0H spec 1 | CEO-3 four disposition classes with reason codes | Mechanical | P5 | Inventory had two transients and corrective-action denials | One transient class |
| 31 | CEO 0H spec 1 | CEO-8 Greptile detection, ready transition, B4 fallback | Mechanical | P1 | Draft lifecycle and config precedence were unspecified | Draft-only flow |
| 32 | CEO 0H spec 1 | CEO-9 subcommand for every probe function | Mechanical | P1 | Templates call ten functions across blocks | Four subcommands |
| 33 | CEO 0H spec 1 | CEO-10 show only tabs on the user-named origin | Mechanical | P1 | Reconciles offer-to-attach with rule 1 privacy | Show full tab list |
| 34 | CEO 0H spec 1 | CEO-13 redesigned as payload-vs-journal schema canary on latest | Taste | P1, P2 | Shape-only canary would not have caught Cause A; scope grew to M | Relabel as shape-only drift |
| 35 | CEO 0H spec 1 | CEO-15 one paid PTY case past 100 MiB | Mechanical | P1 | P1 promises an end-to-end outcome | Reader-only acceptance |
| 36 | CEO 0H spec 1 | CEO-16..22 (TODOS edits, A4 safety, regen checks, gstack-post scan, shared note, doctor probe, B1 definitions) | Mechanical | P1, P2 | Spec gaps in items already in scope | Leave implicit |
| 37 | CEO 0H spec 1 | B5 kept as the plan states | Mechanical | P6 | Plan text is the user's direction, not a CEO expansion | Trim to TODO rows |
| 38 | CEO 0H spec 2 | P1 denial sentence reworded to match CEO-3 | Taste | P5, P6 | Literal text contradicted real transients; user can restore the original at the gate | Keep literal P1 |
| 39 | CEO 0H spec 2 | CEO-1 allowlist as hook constant; `messageId` publication rule on both paths; `: autoplan-published` no-op carrier | Mechanical | P5 | Removes manifest compat issue and flush-timing dependence; carrier has no output to act on | Manifest field; payload-path-only rule; `scope` carrier |
| 40 | CEO 0H spec 2 | CEO-2 invocation-window anchor, metadata index, shared extraction module, miss holds commit | Mechanical | P1, P4 | Skill-tool starts keep working; memory bounded; one parser | Slash-turn anchor; duplicate parser |
| 41 | CEO 0H spec 2 | CEO-8 Greptile completion signal and early PR content | Mechanical | P1 | "No comments yet" vs "done" was indistinguishable | Triage-timeout bound |
| 42 | CEO 0H spec 2 | CEO-9 named subcommands with `KEY: value` contract | Mechanical | P5 | Callers need values without shell state | Unspecified |
| 43 | CEO 0H spec 2 | CEO-17 `held` status lifecycle | Mechanical | P1 | P2 "says so at every skill start" was unmet while other files push | Reuse `blocked` |
| 44 | CEO 0H spec 2 | CEO-7 50,000 commits / 5 s bound on every history read | Mechanical | P5 | Large repos | Unbounded main path |
| 45 | CEO 0H spec 2 | CEO-5 default settings; CEO-22 worktree criterion and conditional pointer | Mechanical | P1, P5 | "Default settings" unproven; B1 text keeps worktree rule | Fork override; drop pointer |
| 46 | CEO 0H spec 3 | Post-loop fixes for all 19 review-3 issues (CEO-1/2/6/9/13/15..20/22, CEO-23, 3 baseline edits) | Mechanical | P1, P5 | Loop cap reached; fixes recorded, not reviewer-confirmed | Stop with issues open |
| 47 | CEO 0H spec 3 | CEO-19 MEDIUM returns to caller's question | Mechanical | P1 | P2 "without getting weaker" | Post MEDIUM silently |
| 48 | CEO 0H spec 3 | CEO-6 one-off dispatch instead of a per-PR macOS step | Mechanical | P3 | Avoids a permanent required-check cost for a one-time record | Per-PR step |
| 49 | CEO 0H | Approve CEO scope documents and continue to 0I (document approval, option A) | Mechanical | P6 | Both inputs reflect the exact decisions; reviewer concerns recorded | Revise / pause |
| 50 | CEO voices | UC1 fail-soft on environment-unverifiable guard states | User Challenge | — | Native F2 and Codex #2 agree; never auto-decided | — |
| 51 | CEO voices | UC2 B2 behind opt-in until measured | User Challenge | — | Native F8 and Codex #5 agree; never auto-decided | — |
| 52 | CEO voices | One PR with admission cutoff (CEO-26) over a release split | Taste | P6 | Garry's one-PR rule; Codex agrees; native recommends split | Three releases |
| 53 | CEO voices | CEO-31 reuse contributor tests, keep rewrite policy | Taste | P4 | Codex #7 valid; user policy kept | Drop rewrite rule |
| 54 | CEO voices | CEO-24 PTY-first gate and live transitions | Mechanical | P1 | Both voices: promise needs live proof | Fixture-only |
| 55 | CEO voices | CEO-25 tail-read spike | Mechanical | P1, P3 | Alternative not analyzed | Commit two-pass now |
| 56 | CEO voices | CEO-13 daily, key-set equality, injected-strip fixture, merge-day run | Mechanical | P1 | F5/F6/F11, Codex #2 | Weekly allowlist-only |
| 57 | CEO voices | CEO-27 coupled artifact groups and drain liveness | Mechanical | P1 | Codex #3, native F7 | Per-file holds only |
| 58 | CEO voices | CEO-12 log allows too | Mechanical | P2 | Denominator for "stop crying wolf" | Denials only |
| 59 | CEO voices | CEO-28 classifier counts severity words | Mechanical | P2 | Discovered defect: 7-finding review printed clean | Leave |
| 60 | CEO voices | CEO-29 doctor triage rows; CEO-30 upstream request | Mechanical | P2 | Faster triage; path to supported surface | Skip |
| 61 | CEO voices | Payload premise corrected (baseline edit) | Mechanical | P5 | Cause A contradicts "same input" | Keep wording |
| 62 | CEO S1-10 | Sections 1-10 findings resolved by existing CEO rows; no new rows | Mechanical | P6 | Each finding maps to an accepted obligation or UC | — |
| 63 | DX 0A-0E | Product type skill suite + CLI; persona daily gstack user; TTHW target Competitive; magical moment via existing messages; mode POLISH | Mechanical | P5, P6 | Overrides and README evidence | Champion target; new surfaces |
| 64 | DX voices | DX-1..DX-16 accepted (docs deliverable, paths, upgrade, status table, skip reversal, gstack-post contract, probe naming/--model, doctor states, partial history, B2 status lines, classifier contract, doc touchpoints, no-op prompt check, log bound, Windows, TTHW) | Mechanical | P1, P5 | Both voices confirmed all six dimensions | Leave as written |
| 65 | DX voices | DX-17 pre-push per-email allowlist | Taste | P1, P2 | Escape hatch short of --no-verify; Claude only | No allowlist |
| 66 | DX voices | DX-18 B3 window >= 1 release and 14 days | Taste | P1 | Codex high; plan said one release | One release |
| 67 | DX voices | B2 opt-in reinforced (UC2) | User Challenge | — | Both DX voices agree with CEO voices | — |
| 68 | DX voices | Doctor --json and novice install timing deferred; bound env overrides rejected | Mechanical | P3, P5 | DX POLISH adds no surfaces | Add now |
| 69 | Eng Step 0 | Scope accepted as-is; structure = original arrangement with reason/record modules split out | Mechanical | P2, P5 | Override never reduces; module split keeps owners under 800 lines | Smaller arrangement with cuts |
| 70 | Eng voices | ENG-1..ENG-17, ENG-20, ENG-21 accepted | Mechanical | P1, P5 | Both voices confirmed five dimensions; each item cites code | Leave as written |
| 71 | Eng voices | ENG-5 index cache only if rescan misses 1 s budget | Taste | P3, P5 | Claude recommends cache; CEO skipped X9 over trust input; spike decides | Adopt cache now / never |
| 72 | Eng voices | ENG-18 automated paid case = Phase 1 entry + one transition; every-transition run manual | Taste | P3, P6 | ~10-minute eval preference vs CEO-24 every-transition | Automated every-transition case |
| 73 | Eng voices | ENG-19 repair unrelated pin-bump reds in wave (one round), named reds to Garry | Taste | P6 | Garry's fix-in-same-PR rule; Claude suggested quarantine | Quarantine under CASE_QUARANTINE |
| 74 | Eng voices | ENG-9 replaces DX-6 rule-id confirm with byte digest token | Mechanical | P1 | Codex P1: rule ids cannot bind bytes | Rule-id confirm |
| 75 | Eng voices | ENG-7 replaces CEO-17 lock clause; narrows CEO-27 to an explicit group map | Mechanical | P1, P5 | Age cannot prove abandonment; coupling map did not exist | Age-only rule; allowlist-derived groups |
| 76 | Eng voices | ENG-8 amends CEO-7 for url/unknown targets; line mapping; mailmap | Mechanical | P1 | Private-remote emails must not count as public | All remotes |
| 77 | Eng TODOs | Collected 6 TODO items as pending writes (no repo edits allowed in this run) | Mechanical | P6 | Parent restricted edits to the plan | Write TODOS.md now |
