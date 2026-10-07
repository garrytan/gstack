# /autoplan publication guard: troubleshooting

`/autoplan` installs a `PreToolUse` hook (`autoplan/bin/phase-publication-hook`)
at its phase boundaries. Before it lets a phase-entry `Read` or a reviewer
`Agent` dispatch run, it reads this session's own Claude Code journal
(`~/.claude/projects/<project>/<session>.jsonl`) and checks that the previous
phase's report was published as parent assistant text.

Every guard message names a **code**, the Claude Code version that wrote the
journal, and a link to the section below for that code. Include the code and
version when you report a problem. The guard's decision log (see
[The decision log](#the-decision-log)) holds the same information.

Each code has one of four dispositions:

| Disposition | What it means | What you do |
|-------------|---------------|-------------|
| Unverified allow | Claude Code left this call uncheckable. The call runs, with a visible warning. | Nothing, unless it keeps happening (then report it). |
| Fallback | Retrying cannot help. | Run the fallback below. |
| Corrective | One named action must happen first. | Take that action. |
| Transient | Something is still in progress. | Wait for the named thing, then continue. |

**The fallback** (printed in every fallback denial):

1. Run the reviews by hand: `/plan-ceo-review`, then `/plan-devex-review`,
   then `/plan-eng-review`.
2. Or move to a fresh session and keep your work: `/context-save`, start a new
   Claude Code session in the project (not `--resume`), `/context-restore`,
   then `/autoplan <plan path>`.

There is no environment variable that turns the guard off.

## How a phase transition is published

Claude Code can write a tool call to the journal after the hook has already
run, and text in the same assistant message as a tool call can be invisible
to the hook. So the guard counts a phase report only when a later journaled
record follows it: a tool result, or a record from another assistant message.

The phase-close procedure therefore publishes each report in a message whose
only tool call is the Bash no-op `true autoplan-published <phase>` (it prints
nothing and needs no permission; Claude Code 2.1.292 asks for approval of a bare
`:` command, so the no-op is `true`), and makes the next phase's `Read` or `Agent`
call in a later message. Sessions that put the report and the next phase's
call in one message get one [`publication_unflushed`](#publication-unflushed)
denial naming that fix.

When Claude Code has not yet written the current call, the guard evaluates the
call from the hook payload instead (Claude Code's own parsed input), placed
after the last journaled record. The previous phase's report must still be in
the journal.

## Unverified allows

These states are caused by Claude Code, not by the model. The guard lets the
call run without a permission decision (Claude Code's own permission check
still runs), prints a warning to you that names the code, and logs the allow
with `disposition: "unverified"`. For that one call it does **not** check that
the previous phase's report was published.

> [autoplan] phase publication was NOT verified for this session (journal_lag): ...

<a id="unrecognized-shape"></a>
### `unrecognized_shape:<detail>`

The journal root has a shape the guard does not know, usually because Claude
Code changed its journal format. The guard reads the journal twice and allows
only when both reads agree. `unrecognized_shape:cwd_spelling` means the
journal's directory is the same folder as the project, spelled differently.
Please report the detail and version.

<a id="journal-lag"></a>
### `journal_lag`

Claude Code had not written the previous assistant message to the journal
(a tool in an earlier message still has no result, or an ancestor record is
missing) and did not catch up within 2 seconds.

<a id="rewritten"></a>
### `rewritten`

The journal bytes the guard had already read changed during one hook call.
Claude Code normally only appends. Rewrites between hook calls are not
detected.

<a id="too-large"></a><a id="journal-too-large"></a>
### `too_large`

A single journal record is over the 32 MiB record limit (`OWNED_RECORD_MAX_BYTES`).
The guard reads long journals record by record, so a large journal alone
never triggers this; one enormous record (for example a huge pasted file) does.

<a id="unseen-version"></a>
### `unseen_version`

A Claude Code release newer than the one gstack has checked passes the hook a
reviewer dispatch without a key the journal has (a schema strip). The daily
`autoplan-schema-canary` case catches these within a day of a release.

## Fallback denials

<a id="competing-root"></a>
### `competing_root`
The journal has more than one conversation root, or two records share one UUID.

<a id="foreign-cwd"></a>
### `foreign_cwd`
The journal's root was written in another project directory, after spelling
and symlinks are taken into account. Linked git worktrees of the project are
accepted.

<a id="sidechain"></a>
### `sidechain`
The first turn or its ancestry is a sidechain (subagent) record, not the parent session.

<a id="agent"></a>
### `agent`
The conversation ancestry passes through a subagent record.

<a id="cycle"></a>
### `cycle`
The journal's parent links form a loop.

<a id="identity"></a>
### `identity`
The journal path, its directories or the file failed the identity checks: a
symlink, a foreign session, the wrong directory layout, a different file, or a
journal that shrank. A rerun hits the same check.

<a id="malformed"></a>
### `malformed`
A complete journal line is not valid JSON or UTF-8, or its records contradict
each other.

<a id="journal-missing"></a>
### `journal_missing`
The session journal named by the hook does not exist after 2 seconds.

<a id="event-order"></a>
### `event_order`
The journal's events could not be put in a consistent order for this session.

<a id="tool-identity"></a>
### `tool_identity`
Two journal records claim the same tool call identity.

<a id="current-mismatch"></a>
### `current_mismatch`
The journal records the current call with a different tool or input than
Claude Code passed to the hook. Only `run_in_background` (which Claude Code's
fork-subagent schema drops) and the spelling of `file_path` may differ.

<a id="agent-key"></a>
### `agent_key`
The reviewer dispatch carries a key outside `prompt`, `description`,
`subagent_type` (`general-purpose` only) and `run_in_background`. A model
override is not allowed for /autoplan reviewer dispatch. The log records the
key names, never their values.

<a id="cross-phase-batch"></a>
### `cross_phase_batch`
One assistant message enters two different phases. Calls that enter the same
phase may share a message; another phase needs its own message after the
previous report.

<a id="init-mismatch"></a>
### `init_mismatch`
The snapshot init result or its artifacts (restore point, active plan header)
do not match this invocation.

<a id="snapshot"></a>
### `snapshot`
A phase snapshot, methodology or other immutable artifact is missing, aliased,
writable or changed.

<a id="dispatch-prompt"></a>
### `dispatch_prompt`
The reviewer prompt differs from the snapshot's exact `nativeDispatchPrompt`.

<a id="evidence"></a>
### `evidence`
An artifact the guard needed could not be parsed.

<a id="publication-repeat"></a>
### `publication_repeat`
The report was published separately once in this invocation and still cannot
be verified, so Claude Code is not writing it to the journal in time.

## Corrective denials

<a id="publication-missing"></a>
### `publication_missing`
No filled report for the previous phase appears after its close packet Read.
Publish it as your own assistant text in a message whose only tool call is
`true autoplan-published <phase>`, then enter the next phase in a later message.

<a id="publication-unflushed"></a>
### `publication_unflushed`
The report shares the current call's message, or nothing journaled follows it
yet. Publish it in its own message with the no-op call, then enter the next
phase in a later message. A second occurrence in one invocation becomes
[`publication_repeat`](#publication-repeat).

<a id="close-required"></a>
### `close_required`
Finish the previous phase's close procedure and Read its close packet.

<a id="close-incomplete"></a>
### `close_incomplete`
Read every line of the current close packet.

<a id="close-stale"></a>
### `close_stale`
The close packet or its checkpoint no longer matches the current phase input.
Prepare a fresh packet and read it.

<a id="close-edits"></a>
### `close_edits`
The plan changed after the close Read in a way the guard cannot reconstruct,
or it fails its phase check. Repeat the close procedure.

<a id="init-required"></a>
### `init_required`
No successful snapshot init for this invocation. Run the existing init step.

<a id="init-own"></a>
### `init_own`
A new `/autoplan` turn needs its own init (it may answer `reused: true`).

<a id="init-failed"></a>
### `init_failed`
The init step failed. Complete it first.

<a id="init-unbindable"></a>
### `init_unbindable`
Init ran through a shell variable, substitution, chaining, a pipe or a
redirect. Re-run it as one Bash call with literal absolute paths.

<a id="phase-order"></a>
### `phase_order`
Enter Phase 1 (CEO) before a later phase.

<a id="hook-input"></a>
### `hook_input`
The hook could not read its input. Restore the installation (`./setup`).

<a id="installation"></a>
### `installation`
The hook failed unexpectedly. Restore the installation (`./setup`).

<a id="foreign-install"></a>
### `foreign_install`
The phase file belongs to another gstack installation than the hook. Restore
this installation (`./setup`).

## Transient denials

<a id="entry-pending"></a>
### `entry_pending`
A phase-entry call from an earlier message has no result yet. Wait for it.

<a id="mutation-pending"></a>
### `mutation_pending`
An edit to the active plan after the close Read has no result yet. Wait for it.

<a id="changing"></a>
### `changing`
Claude Code was writing the journal on every read for 2 seconds. Wait for the
current response to finish.

## Removed codes

<a id="current-missing"></a><a id="pending-read"></a>
Before the October 7, 2026 release, "Native parent evidence has not reached
the journal yet" (no code) and "Current native phase-entry identity is
required before entering a new phase" denied calls Claude Code had not yet
journaled. The payload path replaced both.

## Claude Code settings

`CLAUDE_CODE_FORK_SUBAGENT=false` is no longer needed (keeping it is harmless).
With the fork-subagent gate on, reviewer dispatches may run in the background:
the dispatch returns a launch receipt and the review arrives later as a
completion notice. Wait for that notice before closing the phase. A background
reviewer keeps the invocation armed, so a typed message while it runs does not
end `/autoplan`.

## Supported journal roots

The guard accepts exactly one root per journal file:

- A user message with no parent (sessions without hooks).
- An unbroken chain of message-less `SessionStart` hook attachments
  (`hook_success`, `hook_additional_context`, ...) that starts at a null parent
  and ends at the first user turn. Claude Code writes this when any
  `SessionStart` hook is installed, including hooks that plugins add. It also
  writes one after `/clear`.
- A `compact_boundary` record whose logical parent is not in the file, but only
  when it is the file's first record. Claude Code writes this when you resume a
  compacted session with `--fork-session`.

`--continue`, `--resume` and `/compact` append to the same journal, and the
guard follows them through their existing parent links. The real journals
these rules were checked against came from Claude Code 2.1.284
(`test/fixtures/claude-native-journal-roots-2.1.284.json`); the periodic
`autoplan-journal-drift` canary re-checks the pinned Claude Code.

## The decision log

Every guarded decision appends one line to
`<state root>/analytics/autoplan-guard.jsonl` (normally
`~/.gstack/analytics/autoplan-guard.jsonl`): `schema`, time, `decision`
(`allow` or `deny`), `disposition`, `code`, `path` (`journal`, `payload` or
`none`) and the Claude Code version. It never holds content; an `agent_key`
denial adds the key names, and an unrecognized shape adds record type names.
The file keeps the newest 1,000 lines once it passes 256 KiB. A failure to
write it never changes a decision.

## Windows paths

Claude Code and Git Bash can spell one path as `C:\x`, `c:\x`, `C:/x` or `/c/x`.
The guard treats these as the same path. It does not resolve `.` or `..`, so a
path containing them is still rejected.
