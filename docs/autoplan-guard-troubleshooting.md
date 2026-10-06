# /autoplan publication guard: troubleshooting

`/autoplan` installs a `PreToolUse` hook (`autoplan/bin/phase-publication-hook`)
at its phase boundaries. Before it lets a phase entry `Read` (or a reviewer
`Agent` dispatch) run, it reads this session's own Claude Code journal
(`~/.claude/projects/<project>/<session>.jsonl`) and checks that the previous
phase's report was published as parent assistant text.

To do that it must first prove which journal records belong to this session.
It walks the record chain from the first conversation turn up to its root. When
it cannot prove ownership it reports a **code**. This page explains each code
and what to do.

Every message from the guard names the code and the Claude Code version that
wrote the journal. Include both when you report a problem.

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
guard follows them through their existing parent links.

The real journals these rules were checked against (startup with two
`SessionStart` hooks, `/compact`, `/clear`, and `--resume --fork-session`
after a compact) came from Claude Code 2.1.284. A redacted copy is in
`test/fixtures/claude-native-journal-roots-2.1.284.json`. A periodic CI
canary, `autoplan-journal-drift`, captures fresh journals from the pinned
Claude Code and checks the reader still accepts them.

## Hard denials

The journal shows a conflict, so retrying cannot help. The guard denies the
phase entry.

| Code | Cause |
|------|-------|
| `competing_root` | The journal has more than one conversation root, or two records share one UUID. |
| `foreign_cwd` | The journal's root was written in another project directory, after spelling and symlinks are taken into account. Linked git worktrees of the project are accepted. |
| `sidechain` | The first turn or its ancestry is a sidechain (subagent) record, not the parent session. |
| `agent` | The conversation ancestry passes through a subagent record. |
| `cycle` | The journal's parent links form a loop. |
| `too_large` | The session journal is over the 32 MiB the guard reads (the message names its size). Long sessions, especially with screenshots, get there; a journal only grows, so retrying never helps. Start a new session for `/autoplan`. |

**What to do:** run the review phases by hand: `/plan-ceo-review`, then
`/plan-devex-review`, then `/plan-eng-review`. Or start a new Claude Code
session in the project directory and run `/autoplan` again. If a fresh session
gets the same code, open an issue with the code and Claude Code version.

## Retry denials

The guard has not reached a conclusion. The message ends with
"no missing-publication conclusion has been made". Retry the same tool.

| Code | Cause |
|------|-------|
| (none) | The journal does not yet hold the records the guard needs. This includes the current tool call, or an ancestor record Claude Code has not written yet. |
| `changing` | Claude Code was writing the journal during every read in the 2-second window. |
| `identity` | The journal path, its directories or the file itself failed the identity checks: for example a symlink, a foreign session, or the wrong directory layout. A journal over the size limit reports `too_large` instead. |
| `malformed` | A complete journal line is not valid JSON or UTF-8, or its records contradict each other. |

If a retry keeps failing with the same code, use the fallback above.

## Unverified phase entry (`unrecognized_shape:<detail>`)

The guard found a journal root it does not recognize. This usually means Claude
Code changed its journal format. In this one case the guard does not block you,
but only when all of the following hold:

- every journal line parses,
- the journal is identical across two reads,
- the current tool call is already in the journal, and
- the only problem is the unrecognized root shape.

The phase entry then goes ahead **without** a permission decision from the
guard, so Claude Code's own permission check still runs. You see:

> [autoplan] phase publication was NOT verified for this session (journal shape unrecognized_shape:...)

The model gets the same notice, with a reminder to publish each phase report.
`unrecognized_shape:cwd_spelling` means the journal's directory is the same
folder as the project, spelled differently.

If any other condition fails, or a hard code also applies, the guard denies
instead.

Each unverified entry adds one line to
`<state root>/analytics/autoplan-guard.jsonl` (normally
`~/.gstack/analytics/autoplan-guard.jsonl`). The line holds the code, the Claude
Code version and the record types at the journal root. It never holds content.
A failure to write this log never changes the guard's decision. Please include
that line when you report the new shape.

There is no environment variable that turns the guard off.

## Windows paths

Claude Code and Git Bash can spell one path as `C:\x`, `c:\x`, `C:/x` or `/c/x`.
The guard treats these as the same path. It does not resolve `.` or `..`, so a
path containing them is still rejected.
