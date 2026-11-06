# Skill gates: opt-in enforcement hooks

gstack's advisory skills say what a careful agent does; a gate makes one rule hold. Each gate is a Claude Code hook that is off unless you turn it on, never changes the skill's text, and leaves a countable marker for every decision it makes (GST-1461). They follow the contract hook in [skill-routing-and-contracts.md](skill-routing-and-contracts.md): the same switch order, the same per-session record, the same fail-open rule.

| Gate | Switch | What it holds |
|---|---|---|
| /investigate | `investigate_gate` | After /investigate loads, changes to tracked source wait until the session states a root cause |
| /plan-ceo-review | `ceo_review_gate` | After /plan-ceo-review loads, the final stop (of the session or of a review subagent) waits until the review's output file ranks the top risks |

## Turn a gate on

The switch resolves like the contract hook's, and the first one set wins:

1. The `./setup` flag: `--investigate-gate` / `--no-investigate-gate` (also `--investigate-gate=on|off`), or `--ceo-review-gate` / `--no-ceo-review-gate` (also `--ceo-review-gate=on|off`). A flag is saved to config.
2. The environment: `GSTACK_INVESTIGATE_GATE=on|off` or `GSTACK_CEO_REVIEW_GATE=on|off`. Not saved.
3. Config: `gstack-config set investigate_gate on|off` or `gstack-config set ceo_review_gate on|off`.
4. The default, `SWITCH_DEFAULT` in `lib/skill-route.ts`: off for both.

Setup registers a gate's shims in `~/.claude/settings.json` when its switch is on (four for /investigate; Stop and SubagentStop for /plan-ceo-review) and removes them when it is off. The hooks also read the switch on every call, so `gstack-config set investigate_gate off` takes effect on the next tool call or stop.

### Headless runs

For `claude -p` or an eval harness, skip settings.json:

    gstack-skill-gates settings --investigate --ceo-review > gates.json
    claude -p "<task>" --settings gates.json

Name one gate or both. The JSON registers their hooks from this checkout and sets `GSTACK_INVESTIGATE_GATE=on` and `GSTACK_CEO_REVIEW_GATE=on` through its `env` block. Under the Agent SDK, pass the same JSON as settings or include `user` in `settingSources` after running setup; with neither, or with `--bare`, no hook loads and no `fired` marker appears. Check every session with `gstack-skill-gates report --session <id> --expect armed` ([exit codes](#exit-codes)).

## The /investigate gate

Once a session loads /investigate (the Skill tool, a typed `/investigate`, or a Read of its installed SKILL.md), the gate arms on the next Edit, Write, MultiEdit, NotebookEdit or Bash call. From then until the session states a root cause:

- **Edit, Write, MultiEdit and NotebookEdit** on a tracked source file are denied before they run.
- **Bash** can't be judged from its command line (`sed -i`, a redirect, `tee`, `python -c`, `perl -pi`, `node -e`, `git apply`, a heredoc, a build step that rewrites a file). So the gate compares the tree instead. When it arms it pins a baseline: the repository root, HEAD, its refs and stash list, and the content of every tracked file that differs from HEAD. Every later Edit/Write/Bash hook call, every PostToolUse and PostToolUseFailure on Bash, and Stop compare the tree with that baseline under a session lock. A tracked source file whose content changed is put back and the call or stop is blocked with the files named. Because every check uses the same baseline, a write from a background command or a parallel call is caught at the next check whichever call made it.

A change is not a fix write, and is folded into the baseline, when the file's new content is its blob in HEAD (`git checkout -- f`, `git stash`), in a commit that existed before the baseline (`git checkout <branch>`, `git bisect`), in a commit a remote-tracking ref holds (`git pull`, `git merge origin/main`), or in a stash entry that existed before (`git stash pop`). A commit made after the baseline that touches a gated file is undone with `git reset --soft` to its newest ancestor that existed before (or that a remote-tracking ref holds), so a fix committed on another branch moves that branch back to its own tip, including a branch behind the baseline HEAD (`git checkout main && <fix> && git commit` from a feature branch moves main back, and the feature branch is untouched). An amend or rebase of commits from before the baseline is undone to that branch's tip when the gate armed: the baseline HEAD on the same branch, or the other branch's own recorded tip. A branch created after the baseline goes back to that newest older ancestor. The commit stays in the reflog, those index entries are reset, the files are put back, and the block names the commit's other changes still staged. A commit pushed to a remote counts as upstream, so a fix pushed in the same command is not undone.

**What counts as source.** A file tracked by git that is not a test path (gstack-diff-scope's test rule plus `fixtures/`), a doc (`.md`, `.mdx`, `.rst`, `.txt`, `.adoc`), a lockfile (`bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `uv.lock`, `poetry.lock`, `Gemfile.lock` and the like), a `linguist-generated` path (read from the baseline commit's attributes, so a `.gitattributes` written after the gate armed exempts nothing), or a tracked symlink. New untracked files are never blocked, so a repro script, a new failing test and temporary logging in a scratch file all work. Changes to excluded files are recorded as `observed`, never reverted.

**What releases it.** A line in the assistant's own reply, after at least one Read, Grep, Glob or Bash call since the load:

    Root cause: <what is actually wrong, with file:line>

That is the `Root cause:` label of the skill's DEBUG REPORT. A placeholder (`[what was actually wrong]`, `TBD`) or a hedge (`unknown`, `unclear`, `still investigating`, `see below`, `n/a`) does not count, and neither does the text inside a tool result or a file. The block text names the form, and the rejected value when there was one. After the release the gate does nothing for the rest of that /investigate run; a new load arms it again.

**Restoring is careful.** The gate never writes through a symlink: it refuses a parent that is not a real directory inside the repository and replaces the path with a rename, so a tracked file swapped for a link to `~/.bashrc` comes back as the file and the link's target is untouched. Files clean at the baseline come back through `git cat-file --filters` (line endings and LFS smudging intact); files dirty at the baseline come back from a raw copy in the session directory, keyed by the sha256 of its bytes. A file clean at the baseline keeps its current permissions (the tree's mode only when the file is gone); a file dirty at the baseline gets its baseline mode back. Each restored file's index entry goes back to the baseline's, including a change that was only staged, so a rejected edit that was `git add`ed is not left staged and staged work is not dropped. Before a file is put back, the content it replaced is copied into the session directory and the block names that copy, so an edit made in an editor or another session at the same time is never lost. A path that cannot be put back (it is now a directory, the disk is read-only) gives [GATE_RESTORE_FAILED](#gate-restore-failed).

**Known gaps.** Paths marked assume-unchanged or skip-worktree, untracked files that shadow a tracked module, and ignored directories are outside the check. While the gate is armed it also puts back an edit you make to tracked source in your editor, since it cannot tell who changed the file.

## The /plan-ceo-review gate

Once a session loads /plan-ceo-review (the Skill tool, a typed `/plan-ceo-review`, or a Read of its installed SKILL.md), its final stop is held until the review's output ranks the top risks. Only a final stop counts, by the contract hook's rule (`isFinalTurn` in `lib/skill-contract.ts`): a STATUS line other than `NEEDS_CONTEXT`, or a turn that does not end waiting on the user. A stop that asks the user a question (a closing `?`, `AskUserQuestion`, `STATUS: NEEDS_CONTEXT`) in an interactive session is never blocked; in a session no human answers (`gstack-session-kind` says `headless` or `unattended`) it counts as final.

**What meets it.** One output file, modified after the load (its mtime is later than the load record's transcript timestamp), with a markdown heading whose text contains `Findings` or `Top risks` (any level, any case), followed inside that section by a numbered list that starts at 1 and has at least one item that is not a placeholder (`[risk]`, `TBD`, `...`). A bullet list, a list starting at 2, a list under the next same-level heading, or a section of placeholders does not count:

    ## Findings

    1. Payment retries can double-charge when the provider times out.
    2. No rollback path for the new orders schema.

**Which files count**, in order, stopping at the first one that meets it:

1. `GSTACK_CEO_REVIEW_OUTPUT`, when set (relative paths resolve against the session's cwd).
2. Files the run wrote with Write, Edit or MultiEdit.
3. Markdown files in the git repository at the session's cwd that differ from HEAD or are untracked and not ignored.
4. `$GSTACK_STATE_ROOT/projects/<slug>/ceo-plans/*.md`, with the slug from `bin/gstack-slug`.

Bash commands are never parsed: a review written with a heredoc or `tee` is found by the repository and ceo-plans scans.

**The block.** Its reason starts with the `blocked via=stop` marker and says exactly what to write and where: a `## Findings` section ranking the top risks as a numbered list, in `GSTACK_CEO_REVIEW_OUTPUT`, else the last markdown file the run wrote, else the last plan file it read (never a file in a `skills/` directory, judged from the repository root so a project that itself sits under a `skills/` folder still counts, such as the review's own methodology sections; such a file never releases the gate either), plus each file checked and why it fell short. It never names the off switch.

**The cap.** A run is blocked at most 3 times. The next final stop without ranked risks goes through with an `exhausted` marker and `exhausted_at` in the record. `stop_hook_active` (Claude Code sets it once a Stop hook has blocked the turn) does not skip the check; the cap ends the repeats. After `released` or `exhausted` the gate does nothing for the rest of that run; a new load starts a new run.

**Subagents.** The SubagentStop shim reads the payload's `agent_transcript_path` (Claude Code 2.1 sends it with `agent_id`) and gates the subagent only when that subagent's own transcript loaded /plan-ceo-review, so an Explore or test subagent finishing in a session that ran the review is never touched. Its records are sidechain records, parsed as such. A subagent always ends on a final turn (no human answers it), and its run is counted under `agent` in the record. A payload without the path, or with an empty one, is left alone.

## Markers

Every decision is one marker line:

    GSTACK_GATE <hook> <event> session=<session id> [key=value ...]

| Event | When | Fields |
|---|---|---|
| `fired` | the gate armed for a skill run (once per run; for /plan-ceo-review, its first final stop) | `skill`, `on` (the hook event), `root` (the repository folder name, /investigate only) |
| `blocked` | each refusal | `skill`, `via=edit|bash|stop`, `files` (for `via=stop`, the candidate files checked, or `none`), `n` (blocks so far in this run) |
| `released` | the root cause was stated, or an output file ranks the top risks (once per run) | `skill`, `cause` (first 12 hex of the cause's sha256) or `file` (the output file's name), `blocked` |
| `exhausted` | /plan-ceo-review only: a fourth final stop after 3 blocks, which goes through | `skill`, `blocked` |
| `observed` | an excluded file changed | `skill`, `files` |
| `skipped` | the gate could not arm (once per session and reason) | `skill`, `reason=no-git|no-head` |
| `error` | a hook error; the call or stop went through | `code`, `why` |

Where each one lands:

- **Session record** (the count source): `$GSTACK_STATE_ROOT/skill-gates/<session id>/record.json`, mode 0600, written atomically under the session lock. Per gate and skill run it holds `fired_at`, `released_at`, `cause` or `file`, `blocked`, `observed`, `exhausted_at`, `agent` (a subagent's run), plus the gate's `errors` and `skipped` reasons. `gstack-skill-gates report` reads these.
- **Trace log**: `$GSTACK_STATE_ROOT/hooks/investigate-gate.log` and `hooks/ceo-review-gate.log`, one line per marker in the contract hook's shape (`<time> session=<id> event=<event> key=value ...`). It rotates at 1 MiB, so count from the record.
- **Transcript**: a block puts the marker on the first line of its reason, which Claude Code shows the model (a denied tool's `tool_result`, or a `hook_blocking_error` attachment for PostToolUse, Stop and SubagentStop). `fired`, `released`, `exhausted` and `error` ride `systemMessage`, which the transcript records as a `hook_system_message` attachment and the model never sees, so counting them does not change the session.

The session directory also holds the baseline and the raw copies of files that were dirty when the gate armed. Session directories untouched for 7 days are deleted the next time a gate arms.

<a id="error-codes"></a>
## Errors

A gate never blocks because it broke. On any error it writes an `error` marker with a code to the record, the trace log, stderr and the transcript (`systemMessage`), and exits 0 with no decision, so the call or stop goes through.

| Code | Cause | Fix |
|---|---|---|
| <a id="gate-bad-payload"></a>`GATE_BAD_PAYLOAD` | the hook input is not a JSON object with `session_id` and `transcript_path`, or is over 1 MiB | a Claude Code version change; update gstack |
| <a id="gate-transcript"></a>`GATE_TRANSCRIPT` | the transcript is missing, over 32 MiB, or not a shape the parser knows, or the /plan-ceo-review load record has no timestamp | see [skill-routing-and-contracts.md](skill-routing-and-contracts.md#exit-4-unknown-shape) |
| <a id="gate-timeout"></a>`GATE_TIMEOUT` | the hook ran past its 5 second deadline (`GSTACK_SKILL_GATE_DEADLINE_MS` changes it, up to 20 seconds; a larger value is clamped to 20) | a very large dirty tree or a slow disk |
| <a id="gate-git"></a>`GATE_GIT` | a git command failed or HEAD stopped resolving | run the named git command in the repository |
| <a id="gate-state"></a>`GATE_STATE` | the session record or baseline could not be read or written | make `$GSTACK_STATE_ROOT` writable, or delete `skill-gates/<session id>/` |
| <a id="gate-locked"></a>`GATE_LOCKED` | another hook held the session lock for over 3 seconds | transient; a lock older than 30 seconds is taken over |
| <a id="gate-slug"></a>`GATE_SLUG` | /plan-ceo-review: `bin/gstack-slug` failed, so the ceo-plans directory could not be checked | run `gstack-slug` in the repository; `GSTACK_PROJECT_SLUG` pins it |
| <a id="gate-restore-failed"></a>`GATE_RESTORE_FAILED` | a changed file could not be put back | the block lists restored and failed files; run `git diff HEAD -- <files>` and fix them by hand |
| <a id="gate-unexpected"></a>`GATE_UNEXPECTED` | any other throw | report it with the trace log line |

<a id="hook-timeout"></a>
### Hook timeout: a killed hook cannot fail closed

Claude Code kills a hook that runs past the `timeout` in its registration and then lets the stop or tool call through as if the hook had allowed it. It writes nothing to the stream output about the kill, and the hook settings have no option that makes a timed-out hook block. A gate killed this way leaves no `error` marker either, because its own deadline never fired, so `gstack-skill-gates report` cannot see it. There is no way for the gate to fail closed after a kill.

So every gate registration outlives the gate. `HOOK_TIMEOUT_S` in `lib/skill-gates.ts` is the longest deadline (20 seconds) plus a 5 second margin for Bun startup and the `GATE_TIMEOUT` marker write, rounded up: 25 seconds. `gstack-skill-gates settings` writes it on every hook, and `./setup` reads it from `gstack-skill-gates hook-timeout`; re-running setup updates an older 10 second registration. A slow scan then ends in the gate's own `GATE_TIMEOUT`, which is recorded and makes `report` exit 3. Keep your own settings files at or above this number.

Tested with Claude Code 2.1.318 through `claude -p --settings` only: a Stop hook killed at a 3 second timeout let the stop through, and the same hook with a 15 second timeout blocked it (GST-1615).

## Exit codes

`gstack-skill-gates report [--session <id>] [--expect armed] [--json]` lists each session's gate counts: runs, `fired`, `blocked`, `released`, `exhausted`, `observed` and `errors`.

| Exit | Code | Meaning |
|---|---|---|
| 0 | | done |
| 1 | `SKILL_GATES_USAGE` | a bad argument |
| 2 | <a id="gate-not-armed"></a>`GATE_NOT_ARMED` | `--expect armed` and a session has no `fired` marker: the hooks never loaded (see [Headless runs](#headless-runs)) or the skill never ran |
| 3 | <a id="gate-errored"></a>`GATE_ERRORED` | a session recorded a hook error, so some calls or stops went through unchecked |

## Headless smoke

`bun scripts/skill-gates-smoke.ts` runs the real Claude Code CLI against a local stand-in for the Anthropic Messages API that plays two scripted sessions. The first loads /investigate, reads the file, tries an Edit, tries `sed -i`, states the root cause and edits. The second loads /plan-ceo-review, writes `plan.md` with no Findings and ends its turn (the Stop is blocked), then appends a ranked Findings section through a Bash heredoc and ends again (released). No model is called and nothing is spent. It fetches the pinned CLI (`CLAUDE_CODE_VERSION` in the script, verified at 2.1.318) with npm into a temp directory at run time and never stores it; `--claude <path>` uses one you have. It checks the record, the trace log, the transcript attachments, that `systemMessage` markers never reach a request, that the `sed -i` write was put back, and that the CEO review was released by `plan.md`. Run it after a Claude Code upgrade.
