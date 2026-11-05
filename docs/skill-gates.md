# Skill gates: opt-in enforcement hooks

gstack's advisory skills say what a careful agent does; a gate makes one rule hold. Each gate is a Claude Code hook that is off unless you turn it on, never changes the skill's text, and leaves a countable marker for every decision it makes (GST-1461). They follow the contract hook in [skill-routing-and-contracts.md](skill-routing-and-contracts.md): the same switch order, the same per-session record, the same fail-open rule.

| Gate | Switch | What it holds |
|---|---|---|
| /investigate | `investigate_gate` | After /investigate loads, changes to tracked source wait until the session states a root cause |

## Turn a gate on

The switch resolves like the contract hook's, and the first one set wins:

1. The `./setup` flag: `--investigate-gate` / `--no-investigate-gate` (also `--investigate-gate=on|off`). A flag is saved to config.
2. The environment: `GSTACK_INVESTIGATE_GATE=on|off`. Not saved.
3. Config: `gstack-config set investigate_gate on|off`.
4. The default, `SWITCH_DEFAULT` in `lib/skill-route.ts`: off.

Setup registers the gate's four shims in `~/.claude/settings.json` when the switch is on and removes them when it is off. The hooks also read the switch on every call, so `gstack-config set investigate_gate off` takes effect on the next tool call.

### Headless runs

For `claude -p` or an eval harness, skip settings.json:

    gstack-skill-gates settings --investigate > gates.json
    claude -p "<task>" --settings gates.json

The JSON registers the hooks from this checkout and sets `GSTACK_INVESTIGATE_GATE=on` through its `env` block. Under the Agent SDK, pass the same JSON as settings or include `user` in `settingSources` after running setup; with neither, or with `--bare`, no hook loads and no `fired` marker appears. Check every session with `gstack-skill-gates report --session <id> --expect armed` ([exit codes](#exit-codes)).

## The /investigate gate

Once a session loads /investigate (the Skill tool, a typed `/investigate`, or a Read of its installed SKILL.md), the gate arms on the next Edit, Write, MultiEdit, NotebookEdit or Bash call. From then until the session states a root cause:

- **Edit, Write, MultiEdit and NotebookEdit** on a tracked source file are denied before they run.
- **Bash** can't be judged from its command line (`sed -i`, a redirect, `tee`, `python -c`, `perl -pi`, `node -e`, `git apply`, a heredoc, a build step that rewrites a file). So the gate compares the tree instead. When it arms it pins a baseline: the repository root, HEAD, its refs and stash list, and the content of every tracked file that differs from HEAD. Every later Edit/Write/Bash hook call, every PostToolUse and PostToolUseFailure on Bash, and Stop compare the tree with that baseline under a session lock. A tracked source file whose content changed is put back and the call or stop is blocked with the files named. Because every check uses the same baseline, a write from a background command or a parallel call is caught at the next check whichever call made it.

A change is not a fix write, and is folded into the baseline, when the file's new content is its blob in HEAD (`git checkout -- f`, `git stash`), in a commit that existed before the baseline (`git checkout <branch>`, `git bisect`), in a commit a remote-tracking ref holds (`git pull`, `git merge origin/main`), or in a stash entry that existed before (`git stash pop`). A commit made after the baseline that touches a gated file is undone with `git reset --soft` to its newest ancestor that existed before (or that a remote-tracking ref holds), so a fix committed on another branch moves that branch back to its own tip. An amend or rebase of commits from before the baseline on the same branch is undone to the baseline HEAD; on a different branch the gate blocks but leaves the commit in place rather than move that branch. The commit stays in the reflog, those index entries are reset, the files are put back, and the block names the commit's other changes still staged. A commit pushed to a remote counts as upstream, so a fix pushed in the same command is not undone.

**What counts as source.** A file tracked by git that is not a test path (gstack-diff-scope's test rule plus `fixtures/`), a doc (`.md`, `.mdx`, `.rst`, `.txt`, `.adoc`), a lockfile (`bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `uv.lock`, `poetry.lock`, `Gemfile.lock` and the like), a `linguist-generated` path, or a tracked symlink. New untracked files are never blocked, so a repro script, a new failing test and temporary logging in a scratch file all work. Changes to excluded files are recorded as `observed`, never reverted.

**What releases it.** A line in the assistant's own reply, after at least one Read, Grep, Glob or Bash call since the load:

    Root cause: <what is actually wrong, with file:line>

That is the `Root cause:` label of the skill's DEBUG REPORT. A placeholder (`[what was actually wrong]`, `TBD`) or a hedge (`unknown`, `unclear`, `still investigating`, `see below`, `n/a`) does not count, and neither does the text inside a tool result or a file. The block text names the form, and the rejected value when there was one. After the release the gate does nothing for the rest of that /investigate run; a new load arms it again.

**Restoring is careful.** The gate never writes through a symlink: it refuses a parent that is not a real directory inside the repository and replaces the path with a rename, so a tracked file swapped for a link to `~/.bashrc` comes back as the file and the link's target is untouched. Files clean at the baseline come back through `git cat-file --filters` (line endings and LFS smudging intact); files dirty at the baseline come back from a raw copy in the session directory. Before a file is put back, the content it replaced is copied into the session directory and the block names that copy, so an edit made in an editor or another session at the same time is never lost. A path that cannot be put back (it is now a directory, the disk is read-only) gives [GATE_RESTORE_FAILED](#gate-restore-failed).

**Known gaps.** Paths marked assume-unchanged or skip-worktree, untracked files that shadow a tracked module, and ignored directories are outside the check. While the gate is armed it also puts back an edit you make to tracked source in your editor, since it cannot tell who changed the file.

## Markers

Every decision is one marker line:

    GSTACK_GATE <hook> <event> session=<session id> [key=value ...]

| Event | When | Fields |
|---|---|---|
| `fired` | the gate armed for a skill run (once per run) | `skill`, `on` (the hook event), `root` (the repository folder name) |
| `blocked` | each refusal | `skill`, `via=edit|bash`, `files`, `n` (blocks so far in this run) |
| `released` | the root cause was stated (once per run) | `skill`, `cause` (first 12 hex of the cause's sha256), `blocked` |
| `observed` | an excluded file changed | `skill`, `files` |
| `skipped` | the gate could not arm (once per session and reason) | `skill`, `reason=no-git|no-head` |
| `error` | a hook error; the call or stop went through | `code`, `why` |

Where each one lands:

- **Session record** (the count source): `$GSTACK_STATE_ROOT/skill-gates/<session id>/record.json`, mode 0600, written atomically under the session lock. Per gate and skill run it holds `fired_at`, `released_at`, `cause`, `blocked`, `observed`, plus the gate's `errors` and `skipped` reasons. `gstack-skill-gates report` reads these.
- **Trace log**: `$GSTACK_STATE_ROOT/hooks/investigate-gate.log`, one line per marker in the contract hook's shape (`<time> session=<id> event=<event> key=value ...`). It rotates at 1 MiB, so count from the record.
- **Transcript**: a block puts the marker on the first line of its reason, which Claude Code shows the model (a denied tool's `tool_result`, or a `hook_blocking_error` attachment for PostToolUse and Stop). `fired`, `released` and `error` ride `systemMessage`, which the transcript records as a `hook_system_message` attachment and the model never sees, so counting them does not change the session.

The session directory also holds the baseline and the raw copies of files that were dirty when the gate armed. Session directories untouched for 7 days are deleted the next time a gate arms.

<a id="error-codes"></a>
## Errors

A gate never blocks because it broke. On any error it writes an `error` marker with a code to the record, the trace log, stderr and the transcript (`systemMessage`), and exits 0 with no decision, so the call or stop goes through.

| Code | Cause | Fix |
|---|---|---|
| <a id="gate-bad-payload"></a>`GATE_BAD_PAYLOAD` | the hook input is not a JSON object with `session_id` and `transcript_path`, or is over 1 MiB | a Claude Code version change; update gstack |
| <a id="gate-transcript"></a>`GATE_TRANSCRIPT` | the transcript is missing, over 32 MiB, or not a shape the parser knows | see [skill-routing-and-contracts.md](skill-routing-and-contracts.md#exit-4-unknown-shape) |
| <a id="gate-timeout"></a>`GATE_TIMEOUT` | the hook ran past its 5 second deadline (`GSTACK_SKILL_GATE_DEADLINE_MS` changes it) | a very large dirty tree or a slow disk |
| <a id="gate-git"></a>`GATE_GIT` | a git command failed or HEAD stopped resolving | run the named git command in the repository |
| <a id="gate-state"></a>`GATE_STATE` | the session record or baseline could not be read or written | make `$GSTACK_STATE_ROOT` writable, or delete `skill-gates/<session id>/` |
| <a id="gate-locked"></a>`GATE_LOCKED` | another hook held the session lock for over 3 seconds | transient; a lock older than 30 seconds is taken over |
| <a id="gate-restore-failed"></a>`GATE_RESTORE_FAILED` | a changed file could not be put back | the block lists restored and failed files; run `git diff HEAD -- <files>` and fix them by hand |
| <a id="gate-unexpected"></a>`GATE_UNEXPECTED` | any other throw | report it with the trace log line |

## Exit codes

`gstack-skill-gates report [--session <id>] [--expect armed] [--json]` lists each session's gate counts.

| Exit | Code | Meaning |
|---|---|---|
| 0 | | done |
| 1 | `SKILL_GATES_USAGE` | a bad argument |
| 2 | <a id="gate-not-armed"></a>`GATE_NOT_ARMED` | `--expect armed` and a session has no `fired` marker: the hooks never loaded (see [Headless runs](#headless-runs)) or the skill never ran |
| 3 | <a id="gate-errored"></a>`GATE_ERRORED` | a session recorded a hook error, so some calls or stops went through unchecked |

## Headless smoke

`bun scripts/skill-gates-smoke.ts` runs the real Claude Code CLI against a local stand-in for the Anthropic Messages API that plays a scripted session: load /investigate, read the file, try an Edit, try `sed -i`, state the root cause, edit. No model is called and nothing is spent. It fetches the pinned CLI (`CLAUDE_CODE_VERSION` in the script, verified at 2.1.318) with npm into a temp directory at run time and never stores it; `--claude <path>` uses one you have. It checks the record, the trace log, the transcript attachments, that `systemMessage` markers never reach a request, and that the `sed -i` write was put back. Run it after a Claude Code upgrade.
