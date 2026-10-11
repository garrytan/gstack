# Unattended runs: the artifact contract

A gstack skill runs *unattended* when a parent agent starts it with
`GSTACK_SESSION_KIND=unattended` and reads its artifacts instead of its prose.
This page is the contract between that parent and the run: what the session
kind changes, which files a run writes, how the parent decides whether the run
finished, and how it reads the result without reading any markdown.

The session kinds are: `interactive` (a human answers prompts), `headless`
(`GSTACK_HEADLESS`, `CI`, the eval harness; a question BLOCKs), `spawned`
(an orchestrator subagent; the recommended option is auto-chosen) and
`unattended` (this page). `unattended` is honored only as the explicit
`GSTACK_SESSION_KIND=unattended` override, which outranks `GSTACK_HEADLESS`
so a parent can drive a run inside CI. Nothing in the test or eval harness sets
it, so `headless` keeps its BLOCK semantics.

## What the session kind changes

`gstack-skill-start` prints `SESSION_KIND: unattended` and
`UNATTENDED_SESSION: true`, then applies these rules for the whole skill:

- **No prompts.** The update check, upgrade offer, telemetry and sync consent,
  onboarding tips and routing blocks are suppressed exactly as they are for
  `spawned`. An unanswered consent is `off`.
- **No publishing or sync, enforced at the writers.** Usage analytics are not
  written (`TELEMETRY_WRITE: skipped (unattended session)`), the artifacts
  repo is neither pulled nor pushed (`ARTIFACTS_SYNC: skipped (unattended
  session; mode=<m> queue=<n> retained)`), the sync spool is not fed
  (`gstack-brain-enqueue` is a no-op, and `gstack-review-log` says `review-log:
  sync skipped (unattended session)` on stderr), and `gstack-skill-end` drains
  nothing. Inherited enabled settings and pending queue work are left for the
  next human session. The upgrade offer becomes one line at skill end, read from
  the local cache: `UPGRADE_AVAILABLE: <version>; run /gstack-upgrade`.
- **Questions decide themselves, gates do not.** A question with a
  `(recommended)` option takes it and appends the choice to `decisions.jsonl`
  with `kind: "auto"`. A question with no recommendation, any consent, any
  destructive or irreversible option, and the final approval gate are appended
  with `kind: "approval"` and `status: "pending"`. The skill ends
  at its next gate with the pending list rendered; it never approves and never
  publishes.
- **State root durability is reported.** `STATE_ROOT: <path> durable=yes|no`
  (`no` when the host sets `GSTACK_EPHEMERAL=1`). On an ephemeral root the run
  says `learnings: skipped (state root is ephemeral; set GSTACK_STATE_ROOT)` and
  `timing: analytics skipped (...)` instead of writing to a disk that vanishes.
  Point `GSTACK_STATE_ROOT` at a durable directory when you want cross-run
  history (see [state-root.md](state-root.md)).
- **The autoplan publication guard is named, not faked.** On hosts that do not
  execute Claude Code hooks, and in every unattended session, `gstack-skill-start`
  prints `autoplan guard: not enforced by this host; publication order is
  unverified (GUARD_NOT_INSTALLED)` once. `gstack-artifact validate` requires
  that line in an unattended run's `review-record.md`. Claude Code's
  deny-on-absent behavior is unchanged.

An unknown `GSTACK_SESSION_KIND` value coerces to `interactive` and says so:
`SESSION_KIND: interactive (unknown kind '<x>')`.

## The terminal line

Every workflow skill ends an unattended run with one line the parent greps:

```
GSTACK_RESULT: skill=<name> status=<status> run=<dir>
```

`status` is one of `complete`, `gate_pending`, `incomplete`, `interrupted` or
`refused`; `run` is the directory that holds the artifacts below. `/autoplan`
always ends `gate_pending` when it reaches the final gate, because the gate is
written and never approved. Pure queries (`gstack-artifact schema`,
`gstack-gate render`) print no result line.

Every workflow command shares one exit table: `0` ok, `1` fail, `2` usage,
`3` refused or needs a flag. Error lines end with a result code in parentheses,
for example `findings.jsonl:12: ... (ARTIFACT_SCHEMA)`; each code has an anchor
in [troubleshooting.md](troubleshooting.md#unattended-runs-and-artifacts) with
a `fix:` clause. Grep the code, not the prose.

## The run directory

| File | Schema | Contents |
|------|--------|----------|
| `run.json` | `run` v1 | The manifest: `run` id, `status`, `required_phases`, each phase's `native` and `outside` outcome (`status`, `model`, `provider`), input `snapshot` hashes, `counts`, every artifact's `path` (relative to the run directory) and `sha256`, `session_kind`, `gate_rev`, `deviations`, `consumed_by`. |
| `decisions.jsonl` | `decisions` v1 | One row per decision: `id` (`<run>-<label>`), `title`, `options`, `recommended`, `kind` (`auto`, `approval`, `user_challenge`), `status` (`pending`, `approved`, `overridden`, `rejected`), `gate_rev`, and once answered `chosen`, `answered_at`, `reply`. |
| `findings.jsonl` | `findings` v1 | One row per reviewer finding: `id`, `phase`, `voice` (`native`/`outside`), `model`, `severity`, `title`, `disposition`, `plan_items`, `native_counterpart` (string or null), `source`. Rows share the review-log row shape, so `gstack-review-log --findings` derives review status from this file. |
| `tasks.jsonl` | `tasks` v2 | Implementation tasks with `id`, `title`, `status`, `depends_on`, `findings` (ids in `findings.jsonl`), `blocked_by`, `acceptance`, optional `pr`/`item`/`tier`. |
| `timing.json` | `timing` v1 | Per-phase `started_at`, `ended_at`, `wall_s`, `outside_s`, `native_s`; `started_at` and `total_wall_s` for the run; the Phase 0 `estimate`. |
| `plan.md` | prose | The `## Implementation plan` section, with `## URGENT, outside this plan` written above it. |
| `review-record.md` | prose | The review record and decision audit trail; carries the `GUARD_NOT_INSTALLED` line in an unattended run. |
| `gate.json` | see `gstack-gate --help` | The final gate list `/autoplan` renders and parses. |

Ids are run-bound: every row's `id` starts with `<run>-`, and `run.json` is the
only place the run id is declared. `gstack-artifact schema <name>` prints the
JSON Schema for any of `findings`, `decisions`, `tasks`, `timing`, `run`,
`pregate` and `ship-receipt`; `schema --list` prints the names.

## How a parent consumes a run

1. **Decide whether the run finished.** `gstack-artifact validate <dir>/run.json`
   is the deterministic completion check. It exits `0` and prints
   `ARTIFACT_VALID: run=<id> status=<status>` only when the manifest parses and
   matches its schema, every required phase and each reviewer voice has a
   terminal outcome, every listed artifact exists inside the run directory with
   the recorded hash, every JSONL file parses row by row against its schema with
   run-bound unique ids, task dependencies and finding references resolve
   without cycles, `counts` agree with the files, and (unattended) the guard
   line is present. Otherwise it exits `1` with one error line per problem and
   `ARTIFACT_INVALID: <n> error(s)`; `--json` returns the same as
   `{ valid, run, status, run_dir, errors[] }`. A run that was interrupted shows up here as
   `ARTIFACT_RUN_INTERRUPTED`, never as a partial success.
2. **Read the terminal line.** `grep '^GSTACK_RESULT:' <log> | tail -1`. With
   `status=gate_pending`, the gate is in the artifacts; nothing was approved.
3. **List what is pending.**
   ```bash
   jq -c 'select(.status=="pending")' <dir>/decisions.jsonl
   gstack-gate render <dir>/gate.json          # the numbered list and reply grammar
   ```
4. **Answer the gate** by composing the reply grammar (`all`, `<id><option>`
   tokens such as `d3b uc1a`, or `all except <tokens>`; bare yes/no is
   rejected) and feeding it back with the gate revision you read:
   ```bash
   gstack-gate parse <dir>/gate.json --reply "all except d3b" --gate-rev 1 --json
   gstack-gate decisions <dir>/gate.json --reply "all except d3b" --gate-rev 1 >> <dir>/decisions.jsonl
   ```
   A stale revision is `GATE_REV_STALE` and a reply with unparsed tokens is
   `GATE_REPLY_UNPARSED`; both exit `1` and write nothing.
5. **Read findings and tasks without the prose.**
   ```bash
   jq -c 'select(.severity=="Critical" and .disposition!="accepted")' <dir>/findings.jsonl
   jq -r '.id + "\t" + .title' <dir>/tasks.jsonl
   gstack-artifact urgent <dir>/findings.jsonl   # the URGENT block, or "None."
   ```
6. **Acknowledge consumption** so a second parent (or a retry) can tell the run
   was already read: `gstack-artifact ack <dir>/run.json --consumer <id>` is
   idempotent and records `consumed_by` in the manifest.

## Driving `/autoplan` from a parent: `gstack-autoplan`

On a host where the parent dispatches the reviewers itself (Capy, any
orchestrator without a Claude Code harness), `bin/gstack-autoplan` is the
explicit, durable state machine for the whole run. The parent never reads the
review record; it runs a loop over two commands and reads the printed lines.

```bash
AP=bin/gstack-autoplan
$AP next --out <dir> --plan <plan.md> [--ui|--no-ui] [--developer-tool] [--light] [--spend-cap <usd>]
#   PHASE: ceo snapshot=<sha> order=ceo,design,dx,eng
#   Skipped sections: none (scope: ui=yes,dx=yes,source=detected; checklist=loaded)
#   ATTEMPT: <run>-a1 phase=ceo voice=native  prompt=<dir>/ceo-native-prompt.md  result=<dir>/ceo-native.md  model_family=...
#   ATTEMPT: <run>-a2 phase=ceo voice=outside prompt=<dir>/ceo-outside-prompt.md result=<dir>/ceo-outside.md model_family=differs from the native reviewer
#   SPEND: spent=0.00 reserved=0.00 unknown=0(0.00) worst_case=0.00 cap=none
#   GSTACK_RESULT: skill=autoplan status=awaiting_result run=<dir>
```

1. **Dispatch each `ATTEMPT:`.** The native voice is a subagent on the parent's
   own model given the prompt file; the outside voice is a subagent on another
   model family, or `bin/gstack-outside-voice run --runner codex-cli|api
   --prompt <file> --out <file> [--model <id>]`, which prints
   `OUTSIDE_STATUS: <status> provider=<runner> model=<id> family=<f>`. Every
   reviewer writes its result to the printed `result=` path under the RESULT
   FORMAT below. `next` is idempotent: it reprints open attempts and never
   redispatches on its own (`EXECUTION_UNKNOWN` lists attempts whose process
   died without a result; `--redispatch <attempt>` mints a fresh one and
   `release --attempt <id>` returns its reservation).
2. **Submit each result exactly once.**
   ```bash
   $AP submit --out <dir> --phase ceo --voice native  --result <dir>/ceo-native.md  --model <id> --attempt <run>-a1
   $AP submit --out <dir> --phase ceo --voice outside --result <dir>/ceo-outside.md --model <id> --attempt <run>-a2 [--runner host-subagent] [--usage-usd <n>]
   #   BOUND: <run>-a1 phase=ceo voice=native model=<id> findings=7 sha256=<result hash prefix>
   #   PHASE_CLOSED: ceo confirmed=4 disagree=1 new=2 native_only=1 coverage=both
   ```
   Binding checks the receipt line against the phase snapshot
   (`RESULT_RECEIPT_MISSING`), parses the canonical findings fence
   (`RESULT_FINDINGS_MISSING`), refuses an outside model from the native
   family (`MODEL_FAMILY_CONFLICT`), and refuses a second bind of the same
   attempt or a bind while the phase is not awaiting it (`ATTEMPT_MISMATCH`,
   `PHASE_NOT_AWAITING`, exit 3). Both voices in closes the phase: the
   reconciliation (`confirmed` / `disagree` / `new` per outside finding, with
   disagreement and resolution kept separate) is written to
   `<phase>-consensus.{json,md}`, and the Eng prompt refuses to open without
   every closed prior phase's consensus (`CONSENSUS_MISSING`).
3. **Loop `next` until `status=gate_pending`.** Eng always runs last. The gate
   (`gate.json`, `gate_rev`) lists user challenges as approval items,
   disagreements as auto items and `p1` plan approval; nothing is approved.
4. **Answer the gate** with the reply grammar and the revision you read:
   ```bash
   $AP answer --out <dir> --gate-rev 1 --reply "all"              # APPROVED: status=complete, no new paid phase
   $AP answer --out <dir> --gate-rev 1 --reply "all except d1b"   # REOPENED: ceo,eng (Eng last); next continues the loop
   ```
   A stale revision (`GATE_REV_STALE`, exit 3), bare `yes`/`no`, or a
   conflicting reply (`GATE_REPLY_UNPARSED`) writes nothing. A reply that
   leaves approval items pending records only the answered auto items and
   keeps the gate. A non-recommended choice on a reviewed item reopens that
   phase plus Eng, archives their bound files as `*.r<rev>.*`, and the next
   gate is `gate_rev + 1`; `p1d` reopens every phase; `p1e` ends `incomplete`.
5. **Export and validate.** `$AP export --out <dir>` writes `plan.md` (with
   the `## URGENT, outside this plan` block first), `review-record.md`,
   `tasks.jsonl`, `decisions.jsonl`, `findings.jsonl`, `timing.json` and
   `run.json`; then `gstack-artifact validate <dir>/run.json` and the
   consumption steps above apply unchanged. `$AP status --out <dir>` and
   `resume` work after the run directory moves (paths are re-rooted).

Concurrency and recovery: every state write is a locked read-modify-write
(`run.lock`; a second writer sees `RUN_LOCKED`), attempts are journaled to
`attempts.jsonl` before dispatch, and a parent killed before or after a
`submit` resumes with `next` without a duplicate charge
(`test/autoplan-run-recovery.test.ts`, `test/autoplan-run-concurrency.test.ts`,
`test/autoplan-answer-invalidation.test.ts`). `--spend-cap` admits each attempt
through `spend.json` (`SPEND_CAP_EXCEEDED` refuses, exit 3); host-subagent
spend is `unknown` and counted in `worst_case`. `--deadline <min>` makes the
`run` subcommand cancel the children it started and marks the run
`interrupted`.

### RESULT FORMAT (what every reviewer file must contain)

Each prompt file ends with this contract; `submit` enforces it.

1. The first line is exactly `INPUT: <phase> <snapshot sha256>` (the receipt
   that binds the result to the snapshot both voices reviewed).
2. The review is prose, then one fenced block of canonical findings, one JSON
   object per line: `{"id":"F1","severity":"High","title":"...","file":"...","line":12,"fix":"..."}`
   inside a ```` ```gstack-findings ```` fence. `severity` is Critical | High |
   Medium | Low | Informational; `"user_challenge": true` marks a recommended
   change to the plan's stated direction; `"urgent": true` with
   `"suggested_owner"` marks a security or data-loss finding the plan does not
   own. An empty fence means no findings; a missing fence is refused.
3. The whole result is written to the printed `result=` path.

### Outside-voice runners

| Runner | Access | Record label | Needs |
|---|---|---|---|
| `codex-cli` | repository, read-only, executes here | `repository review` | `codex` on PATH and logged in (`bin/gstack-codex-login` reads `OPENAI_API_KEY` from stdin) |
| `api` | supplied input only | `supplied-input review` | `--model <id>` and `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; never silently equal to a repository review |
| `host-subagent` | the host's | `host-dispatched review` | `--result <file>` the subagent wrote, `--model <id>`; spend `unknown` |

`bin/gstack-outside-voice runners` prints each runner's availability on this
machine; `family <model>` prints the model family `submit` compares. A completed
`api` or `host-subagent` review is a full outside voice in the record, labeled
by its runner. Result codes: `EXECUTION_UNKNOWN`, `RUN_LOCKED`,
`RUN_NOT_INITIALIZED`, `PHASE_NOT_AWAITING`, `ATTEMPT_MISMATCH`,
`RESULT_RECEIPT_MISSING`, `RESULT_FINDINGS_MISSING`, `MODEL_FAMILY_CONFLICT`,
`SPEND_CAP_EXCEEDED`, `CONSENSUS_MISSING`, `OUTSIDE_RUNNER_UNAVAILABLE`
(anchors in [troubleshooting.md](troubleshooting.md)).

## Owner brief

`gstack-owner-brief render --out <dir>` is what the owner sees at the final
gate, interactive or unattended: one page built from `gate.json`,
`decisions.jsonl` and `findings.jsonl` (`BRIEF_INPUT_MISSING` when one is
absent). It opens with the `URGENT, outside this plan` block, then a
plain-language summary (phases closed, findings accepted, how many decisions
take their default, the cycle time; `--summary <file>` or `<dir>/summary.md`
replaces the generated sentence with the run's own), then the numbered
decisions through the gate list: seven per page (`--page N`), stable ids,
each `auto` item annotated with the default taken if unanswered, each
`approval` item `pending until you answer` or `decided <id><letter> on <date>`.
The last line names `review-record.md`, where the full review lives, and the
`gstack-autoplan answer` call that answers the page. `--write` also saves
`brief.md` in the run directory. `/autoplan` Phase 4 presents this output
verbatim and writes the former long report to `review-record.md`.

After the final gate, `gstack-owner-brief close --out <dir> --plan <file>`
rewrites every `draft direction stands until the owner decides` line in the plan
to the decided option and date (`DRAFT_DIRECTION: line <n> <id> rewritten`);
lines whose decision is still pending stay and are reported as
`DRAFT_DIRECTION_UNRESOLVED` (exit 1). `gstack-autoplan answer` runs the same
rewrite when a reply completes the gate (journal event `draft_directions_closed`).

## Timing

`/autoplan` prints `ESTIMATE: ...` at Phase 0 (`gstack-autoplan-timing
estimate --run <id> --out <dir>`, medians of the last ten recorded runs per
phase, or `no history`), records each phase close (`gstack-autoplan-timing
close`), and prints the `CYCLE:` line at the final gate (`gstack-autoplan-timing
summary`). A close without an explicit start measures from the previous phase's
end, else from the run start. The cross-run history lives at
`<state root>/analytics/autoplan-timing.jsonl` and is skipped, with a printed
line, on an ephemeral state root.

## Reference run

`test/fixtures/multi-agent-wave/reference-run/` is a complete unattended
`/autoplan` run (the one that produced this wave's plan) and validates clean.
`test/fixtures/multi-agent-wave/INCIDENTS.md` records what went wrong while it
was produced by hand and which validator rule now catches each incident.
