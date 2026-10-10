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
