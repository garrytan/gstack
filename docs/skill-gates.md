# Skill gates: opt-in enforcement hooks

gstack's advisory skills say what a careful agent does; a gate makes one rule hold. Each gate is a Claude Code hook that is off unless you turn it on, never changes the skill's text, and leaves a countable marker for every decision it makes (GST-1461). They follow the contract hook in [skill-routing-and-contracts.md](skill-routing-and-contracts.md): the same switch order, the same per-session record, the same fail-open rule.

| Gate | Switch | What it holds |
|---|---|---|
| /plan-ceo-review | `ceo_review_gate` | After /plan-ceo-review loads, the final stop (of the session or of a review subagent) waits until the review's output file ranks the top risks |
| /autoplan | `autoplan_gate` | After /autoplan loads, the session's final stop waits until every applicable phase has published its report and the Final Approval Gate is written (GST-1666) |

## Turn a gate on

The switch resolves like the contract hook's, and the first one set wins:

1. The `./setup` flag: `--ceo-review-gate` / `--no-ceo-review-gate` (also `--ceo-review-gate=on|off`), or `--autoplan-gate` / `--no-autoplan-gate` (also `--autoplan-gate=on|off`). A flag is saved to config.
2. The environment: `GSTACK_CEO_REVIEW_GATE=on|off` or `GSTACK_AUTOPLAN_GATE=on|off`. Not saved.
3. Config: `gstack-config set ceo_review_gate on|off` or `gstack-config set autoplan_gate on|off`.
4. The default, `SWITCH_DEFAULT` in `lib/skill-route.ts`: off for both.

Setup registers a gate's shims in `~/.claude/settings.json` when its switch is on (Stop and SubagentStop for /plan-ceo-review; Stop for /autoplan) and removes them when it is off. The hooks also read the switch on every call, so `gstack-config set ceo_review_gate off` takes effect on the next stop.

### Headless runs

For `claude -p` or an eval harness, skip settings.json:

    gstack-skill-gates settings --ceo-review --autoplan > gates.json
    claude -p "<task>" --settings gates.json

Name any of the gates. The JSON registers their hooks from this checkout and sets each named gate's switch (`GSTACK_CEO_REVIEW_GATE=on`, `GSTACK_AUTOPLAN_GATE=on`) through its `env` block. Under the Agent SDK, pass the same JSON as settings or include `user` in `settingSources` after running setup; with neither, or with `--bare`, no hook loads and no `fired` marker appears. Check every session with `gstack-skill-gates report --session <id> --expect armed` ([exit codes](#exit-codes)).

The /investigate gate was retired with /investigate (GST-1717). `./setup` removes its hooks from `~/.claude/settings.json` whatever `investigate_gate` says.

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

Like the /autoplan gate, the hook first re-reads the transcript until it holds the stop's `last_assistant_message`, for at most 2 seconds or half its deadline (`settledTranscript` in `lib/skill-gates.ts`). Claude Code can fire Stop before it writes the turn's last lines, so a single read could miss the Write of a review kept outside the repository (a plan under `~/.claude/plans`) and hold a finished run, or miss the load itself and let an unfinished one through.

**The block.** Its reason starts with the `blocked via=stop` marker and says exactly what to write and where: a `## Findings` section ranking the top risks as a numbered list, in `GSTACK_CEO_REVIEW_OUTPUT`, else the last markdown file the run wrote, else the last plan file it read (never a file in a `skills/` directory, judged from the repository root so a project that itself sits under a `skills/` folder still counts, such as the review's own methodology sections; such a file never releases the gate either), plus each file checked and why it fell short. It never names the off switch.

**The cap.** A run is blocked at most 3 times. The next final stop without ranked risks goes through with an `exhausted` marker and `exhausted_at` in the record. `stop_hook_active` (Claude Code sets it once a Stop hook has blocked the turn) does not skip the check; the cap ends the repeats. After `released` or `exhausted` the gate does nothing for the rest of that run; a new load starts a new run.

**Subagents.** The SubagentStop shim reads the payload's `agent_transcript_path` (Claude Code 2.1 sends it with `agent_id`) and gates the subagent only when that subagent's own transcript loaded /plan-ceo-review, so an Explore or test subagent finishing in a session that ran the review is never touched. Its records are sidechain records, parsed as such. A subagent always ends on a final turn (no human answers it), and its run is counted under `agent` in the record. A payload without the path, or with an empty one, is left alone.

## The /autoplan gate

Opus 5.5 told to run /autoplan in a one-shot session with no human spent about 20 times a plain session and still showed none of autoplan's phases in an eval (GEVA-2's G admission, 0 of 23): nothing held the session until the pipeline finished, and a session could stop after any phase. Autoplan's own publication guard (`autoplan/bin/phase-publication-hook`) only denies entering a phase before the previous one published; this gate holds the stop. It never changes autoplan's text or what an un-gated run does.

Once a session loads /autoplan (the Skill tool, a typed `/autoplan`, or a Read of its installed SKILL.md), its final stop is held until the run is complete. Final stops are judged as for /plan-ceo-review: a stop that asks the user in an interactive session is never held, and in a session no human answers it counts as final.

**What meets it.** One run is the transcript from the load to the next /autoplan load. A full run is complete when:

1. Phase 0 ran scope: a successful `gstack-autoplan-snapshot init` (its `scope` field) or `scope` result with `uiRequired` and `dxRequired`. It decides the applicable phases: CEO and Eng always, Design when `uiRequired`, DX when `dxRequired`.
2. Every applicable phase published, as `sections/phase-close.md` step 6 says: assistant text with its `Phase N complete` line, then a successful Bash no-op `true autoplan-published <phase>`. A no-op with no report since the previous one, or a failed one, does not count.
3. The Phase 4 Final Approval Gate is written: a successful `gstack-gate render` call, or a Write or Edit of a `gate.json`.

A `--ceo-only` run needs Phase 1 published and the `GSTACK_RESULT: skill=autoplan status=reviewed` end line from `sections/ceo-only.md`.

Claude Code can fire Stop before it writes the turn's last lines to the transcript (the smoke run saw a scope call and a phase publication land about 200 ms late), so the hook re-reads the transcript until it holds the stop's `last_assistant_message`, for at most 2 seconds or half its deadline, and judges what is there then.

**What it never holds.** A stop while a native reviewer launched in the background has not reported back (autoplan's "Waiting for <agent ID>" barrier); the next final stop after the notification is checked. A run that drives the `gstack-autoplan` runner (`next`, `submit`, `answer` or `export`), which keeps its own record (docs/unattended.md): it gets one `skipped reason=runner` marker and is never blocked.

**The block.** Its reason starts with the `blocked via=stop missing=<step> published=<phases>` marker and names the next step: run Phase 0 (`missing=scope`), continue at a phase's driver Read when it has not started, finish a started phase's close and publish its report (`missing=ceo|design|dx|eng`), write and render the gate (`missing=gate`), or end a `--ceo-only` run (`missing=end`). It lists the applicable and published phases and never names the off switch.

**The cap and the record.** As for /plan-ceo-review: at most 3 blocks per run, then the next final stop goes through with `exhausted missing=<step>`; `stop_hook_active` does not skip the check. The session record keeps each run's `phases` and `published` as of its last final stop, so `gstack-skill-gates report --session <id> --expect armed --json` says per session whether /autoplan armed, how often it was held, and whether it was released or exhausted. An eval can read exposure from that record instead of from the model's wording.

## Markers

Every decision is one marker line:

    GSTACK_GATE <hook> <event> session=<session id> [key=value ...]

| Event | When | Fields |
|---|---|---|
| `fired` | the gate armed for a skill run (once per run; for /plan-ceo-review and /autoplan, its first final stop) | `skill`, `on` (the hook event) |
| `blocked` | each refusal | `skill`, `via=stop`, `files` (for /plan-ceo-review's `via=stop`, the candidate files checked, or `none`), `missing` and `published` (/autoplan: the next missing step and the phases published so far), `n` (blocks so far in this run) |
| `released` | an output file ranks the top risks, or the /autoplan run is complete (once per run) | `skill`, `file` (the output file's name) or `phases` (the phases /autoplan published), `blocked` |
| `exhausted` | /plan-ceo-review and /autoplan: a fourth final stop after 3 blocks, which goes through | `skill`, `missing` (/autoplan), `blocked` |
| `skipped` | the gate could not arm (once per session and reason), or an /autoplan run drives the gstack-autoplan runner (once per run) | `skill`, `reason=no-git|no-head|runner` |
| `error` | a hook error; the call or stop went through | `code`, `why` |

Where each one lands:

- **Session record** (the count source): `$GSTACK_STATE_ROOT/skill-gates/<session id>/record.json`, mode 0600, written atomically under the session lock. Per gate and skill run it holds `fired_at`, `released_at`, `file`, `blocked`, `exhausted_at`, `agent` (a subagent's run), `phases` and `published` (/autoplan), plus the gate's `errors` and `skipped` reasons. `gstack-skill-gates report` reads these.
- **Trace log**: `$GSTACK_STATE_ROOT/hooks/ceo-review-gate.log` and `hooks/autoplan-gate.log`, one line per marker in the contract hook's shape (`<time> session=<id> event=<event> key=value ...`). It rotates at 1 MiB, so count from the record.
- **Transcript**: a block puts the marker on the first line of its reason, which Claude Code shows the model (a `hook_blocking_error` attachment for Stop and SubagentStop). `fired`, `released`, `exhausted` and `error` ride `systemMessage`, which the transcript records as a `hook_system_message` attachment and the model never sees, so counting them does not change the session.

Session directories untouched for 7 days are deleted the next time a gate arms.

<a id="error-codes"></a>
## Errors

A gate never blocks because it broke. On any error it writes an `error` marker with a code to the record, the trace log, stderr and the transcript (`systemMessage`), and exits 0 with no decision, so the call or stop goes through.

| Code | Cause | Fix |
|---|---|---|
| <a id="gate-bad-payload"></a>`GATE_BAD_PAYLOAD` | the hook input is not a JSON object with `session_id` and `transcript_path`, or is over 1 MiB | a Claude Code version change; update gstack |
| <a id="gate-transcript"></a>`GATE_TRANSCRIPT` | the transcript is missing, over 32 MiB, or not a shape the parser knows, or the /plan-ceo-review load record has no timestamp | see [skill-routing-and-contracts.md](skill-routing-and-contracts.md#exit-4-unknown-shape) |
| <a id="gate-timeout"></a>`GATE_TIMEOUT` | the hook ran past its 5 second deadline (`GSTACK_SKILL_GATE_DEADLINE_MS` changes it, up to 20 seconds; a larger value is clamped to 20) | a very large transcript or a slow disk |
| <a id="gate-state"></a>`GATE_STATE` | the session record could not be read or written | make `$GSTACK_STATE_ROOT` writable, or delete `skill-gates/<session id>/` |
| <a id="gate-locked"></a>`GATE_LOCKED` | another hook held the session lock for over 3 seconds | transient; a lock older than 30 seconds is taken over |
| <a id="gate-slug"></a>`GATE_SLUG` | /plan-ceo-review: `bin/gstack-slug` failed, so the ceo-plans directory could not be checked | run `gstack-slug` in the repository; `GSTACK_PROJECT_SLUG` pins it |
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

`bun scripts/skill-gates-smoke.ts` runs the real Claude Code CLI against a local stand-in for the Anthropic Messages API that plays two scripted sessions. The first loads /plan-ceo-review, writes `plan.md` with no Findings and ends its turn (the Stop is blocked), then appends a ranked Findings section through a Bash heredoc and ends again (released). The second loads /autoplan, runs Phase 0 scope, publishes Phase 1 and ends its turn (the Stop is blocked with `missing=eng`), then publishes Phase 3, writes `gate.json` and ends again (released). No model is called and nothing is spent. It fetches the pinned CLI (`CLAUDE_CODE_VERSION` in the script, verified at 2.1.318) with npm into a temp directory at run time and never stores it; `--claude <path>` uses one you have. It checks the record, the trace log, the transcript attachments, that `systemMessage` markers never reach a request, and that the CEO review was released by `plan.md`. Run it after a Claude Code upgrade.
