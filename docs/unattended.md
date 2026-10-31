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

`gstack-skill-start` prints `SESSION_KIND: unattended`,
`UNATTENDED_SESSION: true` and the `unattended-session` instruction block
(`GSTACK_INSTRUCTION_BEGIN: unattended-session <session-id>` through
`GSTACK_INSTRUCTION_END`), then applies these rules for the whole skill:

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
  the local cache: `UPGRADE_AVAILABLE: <version>; run /gstack-upgrade` (`<version>+<n> (main at <sha>)` when
  main moved <n> commits past the checkout without a new version).
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

A run that writes a record ends with one line the parent greps:

```
GSTACK_RESULT: skill=<name> status=<status> run=<dir>
```

`status` is one of `complete`, `gate_pending`, `incomplete`, `interrupted` or
`refused`; `run` is where the run's record is. `/autoplan`
always ends `gate_pending` when it reaches the final gate, because the gate is
written and never approved. Pure queries (`gstack-artifact schema`,
`gstack-gate render`) print no result line.

Not every workflow writes this line or a run directory today:

- **`/autoplan`** writes the full run directory below through `gstack-autoplan`,
  and `gstack-artifact validate` checks it. It is the only skill with steps
  and helpers that write `run.json`, `decisions.jsonl` and `gate.json`.
- **Workflow commands** `gstack-pregate`, `gstack-regen`, `gstack-restamp` and
  `gstack-ship-queue` print their own line, with `run=` naming their own record
  (the pregate receipt, the regen worktree, the restamp journal, the queue
  record), not a run directory.
- **A refused launch.** Any skill whose install check refuses it at startup
  prints `GSTACK_RESULT: skill=<name> status=refused run=-` and stops.
- **`/ship`** ends with `gstack-ship-receipt result --pr <n>` (or `--body
  .gstack/tmp/ship-receipt.md` after the handoff section), which binds the
  receipt to the branch head, writes the run record and prints
  `GSTACK_RESULT: skill=ship status=complete run=<dir>`. That line and that
  record are the machine-readable READY evidence; [What /ship leaves for a
  parent](#ship-evidence) below is the whole contract (the refused and
  incomplete lines, the one publication an unattended run may make, the
  `review_loop` counters, the outside voice on Capy and the `CARRY:` lines).
- **Every other workflow skill** (`/review`, `/qa`, `/design-review`,
  `/spec`, `/land-and-deploy` and the rest) gets the session rules above (no
  prompts, approvals stay pending, nothing published), but has no step that
  writes a run directory or prints the line, so a parent should not wait for
  either. `/eval-plan` asks for a `gate_pending` line at its spend gate, but no
  helper writes its `gate.json` yet (`gstack-gate` renders and parses a gate
  list; it does not create one). `/cso` skips the shared startup, so these
  session rules do not reach it at all. Read each skill's own record instead:
  the review-log rows (`gstack-review-read`) for `/review` and the
  `qa-report-*.md` file for `/qa`. For a `/ship` run from before the result
  line, read the receipt instead: when the run did not push (an unattended run
  must not), read the receipt file in the child's checkout with
  `gstack-ship-receipt read --body .gstack/tmp/ship-receipt.md --json`;
  use `gstack-ship-receipt read --pr <n> --json` only once a PR exists. In both
  cases compare the receipt's `head` to the branch SHA (`git rev-parse HEAD` in
  the child's checkout): `read` does not check that the receipt is current, so
  an older PR's receipt reads as valid; `result` does.

Every workflow command shares one exit table: `0` ok, `1` fail, `2` usage,
`3` refused or needs a flag. Error lines end with a result code in parentheses,
for example `findings.jsonl:12: ... (ARTIFACT_SCHEMA)`; each code has an anchor
in [troubleshooting.md](troubleshooting.md#unattended-runs-and-artifacts) with
a `fix:` clause. Grep the code, not the prose.

<a id="ship-evidence"></a>
## What /ship leaves for a parent

One section for everything a parent (a Captain, a crew thread, a merge queue)
reads after an unattended `/ship`: the READY evidence, the review loop's
counters, the outside voice's record, and the carry across a base merge.

### The READY evidence: `gstack-ship-receipt result`

`/ship` Step 22 runs `gstack-ship-receipt result --pr <n>` (or `--body
.gstack/tmp/ship-receipt.md` after the handoff section). It binds the receipt
in the PR body (or the handoff file) to HEAD, writes
`<state root>/ship/runs/<utc>-<head12>/` and prints the terminal line:

```
GSTACK_RESULT: skill=ship status=complete run=<dir>
```

The run directory holds `ship-receipt.md` (the block, copied) and
`ship-run.json` with `head`, `pr`, `base`, `version` (`"none"` for a
repository with no version source, [ship-policy.md](ship-policy.md#ship-receipt)),
`queue_mode`, `session_kind`, `receipt` (the copied block's path) and
`receipt_source`. It is a /ship record, not the `run` v1 manifest below, so
read it directly; `gstack-artifact validate` does not apply. A parent's merge
check is then mechanical: take `run=` from the last result line, read
`ship-run.json`, compare its `head` to the PR head, and quote the
`SHIP_RECEIPT: pr=<n> head=<head12> …` line in the READY block.
`gstack-ship-queue ready`, `train build` and `verify --train` make the same
comparison from the PR body ([ship-policy.md](ship-policy.md#ship-before-ready)).

The other endings, each greppable: when gh cannot read the PR,
`GSTACK_RESULT: skill=ship status=incomplete run=-` (exit 1); a receipt that is
missing or names another head, `GSTACK_RESULT: skill=ship status=refused run=-`
with `QUEUE_RECEIPT_MISSING` or `QUEUE_RECEIPT_STALE` on stderr (exit 3), the
line a run that stops before publication prints itself; and `result --pr <n>`
refuses `QUEUE_RECEIPT_STALE` when HEAD is not the PR's pushed head.

The one publication the unattended rules allow: when an open PR for the branch
exists and HEAD is its pushed head, Step 18 takes the pr-body section's
existing-PR path and posts the body (receipt first) and title through
`gstack-post`. It never runs `pr-create`, never pushes a commit and never runs
`gh pr ready`; a branch with no open PR, or whose PR head is not HEAD, takes
the handoff section. When the run committed anything (a CHANGELOG entry,
generated tests), the parent pushes those commits itself, then reruns the
receipt write, the body post and `result` at the pushed head: a receipt for an
unpushed head is `QUEUE_RECEIPT_STALE` to the queue.

### The review loop's counters

The receipt's `review_loop` object, written from `gstack-review-scope summary
--since <REVIEW_SINCE>`, is the loop's machine-readable outcome: `passes`
(Step 9 full passes this ship ran, 1 or 2; up to 3 under `review_scope: all`),
`blocking_found` (distinct blocking findings across them), `deferred`
(blocking findings in unchanged code filed as issues, Step 11's late defers
included), `noted`, `fixed` and `scope`. The
summary line a parent reads prints it as `passes=<n> blocking_found=<k>
deferred=<m>`; the PR body lists the deferred issues under `## Deferred
findings` and the below-floor items under `## Review notes`. A pass that finds
nothing is `NO FINDINGS` from every reviewer and a pass with no edits, which
is the loop's exit, never a failed review ([review-policy.md](review-policy.md)).
Three counters appear only when the run recorded them: `fix_checks` (fix-check
rows, never passes), `dispatches` (reviewer dispatches by role) and
`est_input_tokens` (prompt plus diff bytes the dispatches read, / 4, a relative
estimate and never a bill).

### Report length

A parent reads many lanes, so length is a cost it pays per lane. A READY block
holds its required lines plus at most 150 words; a completion report holds at
most 300 words; a subagent brief names the files to read instead of pasting
them. Evidence goes in files the report points to. Waits go on operations,
never on polling wakes.

### Token caps and fresh-context handoffs

A parent bounds a /ship run with `--token-cap <n>` (or `GSTACK_SHIP_TOKEN_CAP`).
It is an admission cap: /ship meters usage, reserves every step and dispatch
batch before it starts, and stops `status=incomplete` with a `RECOVER:` line
instead of starting work that would cross the cap. Long runs hand Steps 9–11.5
and 12–22 to fresh-context children. The flow, the BUDGET line and the result
codes are in [ship-budget.md](ship-budget.md).

### The outside voice on Capy

Step 11's outside adversarial review prefers the Codex CLI. On a Capy machine
the Codex CLI is normally absent (selecting a model in Capy installs and
authenticates no CLI), and the accepted outside voice is then a subagent
running a different model family from the parent: a full outside voice, not
degraded coverage, as long as the model that reviewed is recorded. Its
review-log row is the same row every Step 11 pass writes
(`ship/sections/adversarial.md`): `skill: "adversarial-review"`,
`phase: "adversarial"`, `source` naming the runner that actually reviewed
(the outside provider that reviewed, with the model recorded, for the
cross-family subagent; `codex` for completed Codex CLI output, as
`ship/sections/adversarial.md` prescribes),
`outside_provider` (the provider the host would have used, as the generated
prose names it), `outside_status` (`completed` for a finished outside pass;
`unavailable` when neither the CLI nor a subagent completed, the cause on the
`gstack-outside-voice run:` stderr line and in `<out>.meta.json` rather than
in the row; `disabled` under
`codex_reviews: disabled`), `status`
(`clean`, `issues_found` or `unavailable`), `completed`, `converged`, and the
subagent's model recorded with the pass (`gstack-outside-voice run --runner
host-subagent --result <file> --model <id> --prompt <file> --out <file>` binds
it; the row's text names it where the host reports it). The native in-host adversarial
subagent writes its own row with `source: "in-host"`; native completion never
credits outside coverage. A parent reads the rows with
`gstack-review-read` and treats `outside_status: unavailable` as missing
coverage, not as a clean outside review.

### The carry across a base merge or a test-only fix

When the parent merges the base in or fixes a test after the receipt was
written, it runs `gstack-ship-receipt carry --pr <n> --base <base> --dry-run`
instead of another /ship; on `CARRY: would carry` it runs `gstack-pregate` at HEAD
and reruns carry with `--pregate .gstack/tmp/pregate.json`. `CARRY: carried from <old> to <new> (<reason>)` plus the
`GSTACK_RESULT: skill=ship status=complete run=<dir>` line means the receipt
now names HEAD with a `carry` object holding the `git range-diff` evidence, and
`ship-run.json` gains `carried_from` and `carry_reason`; the `review_loop`
counters are kept, because the reviewed product diff is unchanged. `CARRY:
current` means nothing moved. `CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)`,
`(RECEIPT_CARRY_TREE_MISMATCH)` or `(RECEIPT_CARRY_REFUSED)` with the refused
result line means the product diff changed, or history was rewritten onto a
tree no review saw, so /ship runs again;
`(RECEIPT_GIT_TOO_OLD)` means the machine's git predates 2.39 and cannot run
`patch-id --verbatim` ([ship-policy.md](ship-policy.md#receipt-carry)).

## The run directory

`/autoplan` writes these files; the next section shows how a parent reads them.

| File | Schema | Contents |
|------|--------|----------|
| `run.json` | `run` v1 | The manifest: `run` id, `status`, `required_phases`, each phase's `native` and `outside` outcome (`status`, `model`, `provider`), input `snapshot` hashes, `counts`, every artifact's `path` (relative to the run directory) and `sha256`, `session_kind`, `gate_rev`, `deviations`, `consumed_by`. |
| `decisions.jsonl` | `decisions` v1 | One row per decision: `id` (`<run>-<label>` at gate revision 1, `<run>-r<rev>-<label>` after a reopen, since labels restart at each gate), `title`, `options`, `recommended`, `kind` (`auto`, `approval`, `user_challenge`), `status` (`pending`, `approved`, `overridden`, `rejected`), `gate_rev`, and once answered `chosen`, `answered_at`, `reply`. |
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

1. **Decide whether the run finished.** For an `/autoplan` run directory,
   `gstack-artifact validate <dir>/run.json`
   is the deterministic completion check (a `/ship` `run=` directory holds
   `ship-run.json`, read directly as described above). It exits `0` and prints
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
   gstack-gate render <dir>/gate.json --all    # the numbered list and reply grammar, every page
   ```
4. **Answer the gate** by composing the reply grammar (`rec`, `as-is`,
   `<id><option>` tokens such as `d3b uc1a`, or `rec except <tokens>`; bare
   yes/no is rejected) and feeding it back with the gate revision you read:
   ```bash
   gstack-gate parse <dir>/gate.json --reply "rec except d3b" --gate-rev 1 --json
   gstack-gate decisions <dir>/gate.json --reply "rec except d3b" --gate-rev 1 >> <dir>/decisions.jsonl
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
A parent on any host reads `autoplan/DRIVER.md` (its path is printed as
`DRIVER:` by `gstack-autoplan --help` and the first `next`) instead of
autoplan/SKILL.md: the phase order, the artifact contract and the gate protocol
in about a hundred lines, generated from the code.

```bash
AP=bin/gstack-autoplan
$AP next --out <dir> --plan <plan.md> [--ui|--no-ui] [--developer-tool] [--no-dx] [--light] [--spend-cap <usd>]
#   PHASE: ceo snapshot=<sha> order=ceo,design,dx,eng
#   SCOPE: ui=yes (...) dx=yes (detected: ...) source=ui:detected,dx:detected
#   DRIVER: <root>/autoplan/DRIVER.md
#   Skipped sections: none (scope: ui=yes,dx=yes,source=ui:detected,dx:detected; checklist=loaded)
#   ATTEMPT: <run>-a1 phase=ceo voice=native  prompt=<dir>/ceo-native-prompt.md  result=<dir>/ceo-native.a1.md  model_family=...
#   ATTEMPT: <run>-a2 phase=ceo voice=outside prompt=<dir>/ceo-outside-prompt.md result=<dir>/ceo-outside.a2.md model_family=differs from the native reviewer
#   SPEND: spent=0.00 reserved=0.00 unknown=0(0.00) worst_case=0.00 cap=none
#   GSTACK_RESULT: skill=autoplan status=awaiting_result run=<dir>
```

The first `next` prints `SCOPE: … source=ui:<flag|marker|detected>,dx:<…>`
and, when CLI flags differ from the plan's marker, `SCOPE_PIN: add <!--
gstack-autoplan-scope: … --> as the first line of <file>`; gstack never writes
the plan.

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
   $AP submit --out <dir> --phase ceo --voice native  --result <dir>/ceo-native.a1.md  --model <id> --attempt <run>-a1
   $AP submit --out <dir> --phase ceo --voice outside --result <dir>/ceo-outside.a2.md --model <id> --attempt <run>-a2 [--runner host-subagent (default)] [--usage-usd <n>]
   #   BOUND: <run>-a1 phase=ceo voice=native model=<id> findings=7 sha256=<result hash prefix>
   #   PHASE_CLOSED: ceo confirmed=4 disagree=1 new=2 native_only=1 coverage=both
   ```
   Submit seals the bytes it bound as `<phase>-<voice>.<attempt>.bound.md`
   (read-only); a later write to the reviewer's file changes nothing bound,
   and another attempt's result file is refused (`ATTEMPT_MISMATCH`).
   Binding checks the receipt line against the phase snapshot
   (`RESULT_RECEIPT_MISSING`), parses the canonical findings fence
   (`RESULT_FINDINGS_MISSING`), refuses an outside model from the native
   family (`MODEL_FAMILY_CONFLICT`), and refuses a second bind of the same
   attempt or a bind while the phase is not awaiting it (`ATTEMPT_MISMATCH`,
   `PHASE_NOT_AWAITING`, exit 3). Both voices in closes the phase: the
   reconciliation (`confirmed` / `unverified` / `disagree` / `new` per outside finding, with
   disagreement and resolution kept separate) is written to
   `<phase>-consensus.{json,md}`, and every later phase's prompts (DX, design
   and Eng alike) carry each closed predecessor's consensus as data; a phase
   refuses to open without one (`CONSENSUS_MISSING`).
3. **Loop `next` until `status=gate_pending`.** Eng always runs last. The gate
   (`gate.json`, `gate_rev`) lists user challenges as approval items,
   disagreements as auto items and `p1` plan approval; nothing is approved.
4. **Answer the gate** with the reply grammar and the revision you read:
   ```bash
   $AP answer --out <dir> --gate-rev 1 --reply "rec" --by human            # every recommendation, plan changes included (APPLY: ...; amend_pending)
   $AP answer --out <dir> --gate-rev 1 --reply "as-is" --by human          # APPROVED: keeps every direction, no new paid phase
   $AP answer --out <dir> --gate-rev 1 --reply "rec except d1b" --by agent:<id> --owner-reply "<owner's words>"
   ```
   `--by human` means the owner typed the tokens; `--by agent:<thread or id>`
   means an agent relayed them, and then `--owner-reply` (or `-` for stdin,
   `--owner-reply-file <path>`) stores the owner's words verbatim
   (`OWNER_REPLY_REQUIRED`); owner words that parse to different choices are
   refused (`GATE_OWNER_REPLY_MISMATCH`). An unattended run refuses an answer
   without `--by` (`ANSWER_BY_REQUIRED`, exit 3) and records the value as
   `answered_by` on every decision row and in the review record's gate line,
   so a gate an agent closed is distinguishable from one the owner closed.
   `gstack-autoplan recommend` changes one recommendation before relay; it
   bumps the gate's `rec_rev`, and a later `rec` needs the `--rec-hash` from
   the render the owner saw (`GATE_REC_STALE`). Every `GATE:` line is followed
   by `GATE_SPEND:` and `GATE_REC_COST:` (also `gate_cost` in `--json`; see
   `autoplan/DRIVER.md`).
   A user challenge both voices raised on a confirmed finding (a title match,
   not file:line proximity alone, which is `unverified`) with the same
   `changes` value is recommended as `b` only with one shared proposal: a
   `--reconcile` record naming it, or the same remedy from both voices.
   Different or missing remedies keep `a`, and option b shows both verbatim
   with the basis. `rec` (alias `all`) takes every recommendation, so it
   accepts the items recommended `b`. Every accepted plan change prints
   `APPLY: <decision id> <title> -> <chosen text>` and becomes a pending
   amendment: `next` refuses with `PLAN_AMEND_PENDING` and `export` refuses a
   `complete` run until `revise --incorporates` names it, or `revise --settle
   <id>` settles a packaging or ordering change that needs no plan edit.
   A stale revision (`GATE_REV_STALE`, exit 3), bare `yes`/`no`, or a
   conflicting reply (`GATE_REPLY_UNPARSED`) writes nothing. A reply that
   leaves approval items pending records only the answered auto items and
   keeps the gate; a later reply never overwrites an earlier answer. An
   accepted change reopens nothing at answer (status `amend_pending`); `revise`
   reopens each phase whose reviewed plan changed plus Eng, archives their
   prompts and consensus as `*.r<rev>.*` (sealed `*.bound.md` results stay in
   place), and the next gate is `gate_rev + 1`; `p1d` reruns every phase on the
   current plan; `p1e` ends `incomplete`.
5. **Export and validate.** `$AP export --out <dir>` writes `plan.md` (with
   the `## URGENT, outside this plan` block first), `review-record.md`,
   `tasks.jsonl`, `decisions.jsonl`, `findings.jsonl`, `timing.json` and
   `run.json`; then `gstack-artifact validate <dir>/run.json` and the
   consumption steps above apply unchanged. `$AP status --out <dir>` and
   `resume` work after the run directory moves (paths are re-rooted; journal
   paths are run-relative). With `GSTACK_AUTOPLAN_CHECKPOINT_DIR` set (on Capy,
   `gstack-config set autoplan_checkpoint drive` defaults it to the private
   project-user Drive folder; unset, the first `next` prints the export line),
   a run at rest, after each bound voice and after each phase transition
   publishes an immutable, hash-listed generation under
   `<dir>/<run>/generations/` and switches `current.json` to it (the previous
   generation is kept; a stale copy never replaces a newer one; a directory
   overlapping the run is refused with `CHECKPOINT_OVERLAP`; a failure is a
   `CHECKPOINT: failed` warning that leaves the command's exit code alone).
   `$AP checkpoints --from <dir>` lists generations with their hash status, and
   `$AP resume --out <new dir> --from <dir>/<run>` restores the newest valid
   one after validating the staged run (`CHECKPOINT_INVALID`).

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
   change to the plan's stated direction and needs `"changes": "scope" |
   "cost" | "direction"` (what accepting it changes); `"urgent": true` with
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

### Hand-run records, revised plans and admission

- **Hand-run reviews.** `submit --record <file>` binds a review that did not
  follow the RESULT FORMAT: the `gstack-findings` fence, one findings table
  (Severity and Title columns), one severity-tagged list (`- [High] title`) or
  a `No findings.` line. Without its `INPUT:` line it binds only with
  `--attest "<reason>"` and `--attempt <id>` (receipt `attested`; refused after
  a later `revise`), and `gstack-artifact validate` prints `attested=<n>`.
  `--attempt` may be omitted when exactly one attempt is open.
  `submit --voice outside --unavailable "<reason>"` (or `--failed`) closes the
  phase `native_only` once native is bound; `next` and `resume` never
  redispatch it.
- **Revising the plan in the same run.** Edit the source plan, then
  `$AP revise --out <dir> --plan <file> [--incorporates <decision id,...>]`.
  Every phase whose reviewed Implementation-plan hash differs reopens (plus
  Eng); newly in-scope phases are added; archives keep `.r<rev>` names with
  `.v<k>` only on collision; a revise at `gate_pending` makes the next gate
  `gate_rev + 1`. `--incorporates` discharges only the named amendments and
  refuses an unchanged plan; `revise --out <dir> --withdraw <decision id>`
  drops one as a journaled owner decision. `next` prints `PLAN_CHANGED` and
  `answer` prints `PLAN_SOURCE_CHANGED` when the source plan moved since the
  snapshot. A plan without both `## Implementation plan` and `## Review record`
  refuses with `PLAN_SECTIONS_INVALID`; `next --scaffold` reviews a copy with
  the missing heading added. `resume` completes an interrupted revise.
- **Admission and upgrades.** `next`, `submit`, `answer`, `revise`, `export`
  and `run` refuse on a Capy host (`GSTACK_CAPY=1`) without an ok install
  verdict for this checkout, HEAD and workflow at `$GSTACK_INSTALL_VERDICT`
  (`INSTALL_UNVERIFIED`), and in any unattended session when the running Bun
  is below gstack's supported minimum (`RUNTIME_BELOW_MINIMUM`); the decision
  is the same one `gstack-skill-start` makes (see Install admission);
  `GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1` overrides and records a run deviation.
  `status` and `resume` are never gated. A run directory written by an older
  gstack prints `GSTACK_VERSION_CHANGED` once and moves forward (legacy
  decision ids are renamed and journaled); one written by a newer gstack is
  refused.

### Carry-forward

A gate revision after the first (`gate_rev` 2 and later, written after a
`revise`) is answered with the owner's recorded words from the revision before
it when nothing new needs their decision. `gstack-autoplan` prints
`CARRIED: gate_rev=<n> <- gate_rev=<m> words="<their words>" by=<relayer> reason=<why>`,
then the usual `APPROVED:` lines, and journals `gate_carried`. The carry needs
all of: the earlier gate approved (`p1a` or `p1b`) with `rec` or "do it"
(not item tokens), no item there left pending, and the owner's words
recorded; that gate was not itself carried; every accepted change incorporated
or settled; the plan file's bytes equal those recorded at the gate or at the
`revise` that took the changes (any later edit refuses, an ELI5-only one
included); no urgent or
outside-plan finding open; and every new gate item one of the cases below.
Anything else prints `CARRY: no (<why>)` (journal `carry_refused`) and the gate
goes to the owner as before. `--no-carry-forward` on the first `next` turns it
off for the run.

- **"do it".** When the owner's words were "do it" (their words, not a
  `captain:` relay of them), a new `auto` item that changes no scope, cost or
  direction, whose recommended option changes no plan text, and is no round
  or budget grant takes its recommendation. The
  decision row gets `carried_under: do it`, the output prints
  `CARRIED_UNDER_DO_IT:` per item, and the approval record lists them as
  "taken under "do it", not seen by the owner". `rec` carries no new item.
- **Unreviewed post-cap delta.** A "plan changed after <phase> cap" item
  recommending `a` (accept) is read by one reviewer before it carries. `CARRY_CHECK:` names the attempt and
  the prompt (the delta against `plan-at-gate.r<m>.md`, the accepted changes,
  the full plan); the run reserves the estimate in `spend.json` and refuses
  when it is over `--carry-check-cap <usd>` (default 5) or the run's cap.
  Dispatch it to a model family other than the plan reviewers', then
  `check --out <dir> --attempt <id> --result <file> --model <id>`
  (`--same-family "<why>"` when no other family is available). A High or
  Critical finding, or `--unavailable "<reason>"`, leaves the gate for the
  owner. The verdict is saved as `carry_check` on `gate.json`, on the
  decision rows (`carry_check`) and in `<dir>/decisions.tsv`. A pending
  check is void, its reservation released and the gate left for the owner,
  when the owner answers the gate, the plan is revised, a new gate is
  written, or the delta changed after dispatch.

Carried rows keep `answered_by: agent:gstack-autoplan` and name their source
(`carried_gate_from`, `carried_gate_rev`, `carried_answered_by`);
`gstack-approvals import --autoplan` writes the carried gate as its own row,
and `gstack-owner-brief render --captain` opens with "Nothing pending.
Carried forward from gate_rev <m>", followed by any items taken under "do it"
without being shown to the owner.

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
It carries a `Cost so far:` sentence (spent, worst case, cap, and the estimate for
the phases `rec` can reopen); `render --captain` puts it in a `### Cost` section above
the relaying-agent trailer. The last line names `review-record.md`, where the full review lives, and the
`gstack-autoplan answer` call that answers the page. `--write` also saves
`brief.md` in the run directory. `/autoplan` Phase 4 presents this output
verbatim and writes the former long report to `review-record.md`.

After the final gate, `gstack-owner-brief close --out <dir> --plan <file>`
rewrites every `draft direction stands until the owner decides` line in the plan
to the decided option and date (`DRAFT_DIRECTION: line <n> <id> rewritten`);
lines whose decision is still pending stay and are reported as
`DRAFT_DIRECTION_UNRESOLVED` (exit 1). `gstack-autoplan answer` runs the same
rewrite when a reply completes the gate (journal event `draft_directions_closed`).

## Lane done: pregate, the sealed guard and the handoff lines

A lane under a coordinator runs `gstack-pregate run --allow-repo-commands` on
its branch before it reports done (the unit tier on the changed files plus
the repo's guards, [docs/pregate.md#guards](pregate.md#guards)). In a repo
whose `.gstack/pregate.json` has a `sealed` key it runs `gstack-pregate sealed`
before any push or PR creation, since a PR tool may not run local hooks. Its
handoff carries, right after the `GSTACK_RESULT` line, the `gstack: ok|fail
<rev>` line and then the `PREGATE:` line. The coordinator contract
(`gstack-autoplan contract`) states the same rule word for word.

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

## Install admission

An unattended run, and a `GSTACK_SESSION_KIND=spawned` run with `GSTACK_CAPY=1`,
starts only on a supported Bun and, on a Capy machine (`GSTACK_CAPY=1`, set by
the installer's `GSTACK_LAUNCH` line), with a passing install verdict for this
checkout, its HEAD and the workflow. Otherwise `gstack-skill-start` prints
`INSTALL: fail runtime|verdict — <detail>; fix: <command> (<CODE>)` and
`GSTACK_RESULT: skill=<s> status=refused run=-`, and exits 3; stop and run the
fix. `GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1` admits anyway (`INSTALL_VERDICT:
overridden`), recorded as a deviation. TypeScript entrypoints use
`checkInstallAdmission` from `lib/install-verdict.ts`; the Bash side is
`bin/gstack-install-verdict.sh`. See [capy-install.md](capy-install.md#the-launch-line).

## The decision trail

A long or unattended run keeps one tab-separated trail of its decisions at
`<run dir>/decisions.tsv`, written through `gstack-decision-trail <file>
<phase> <decision> <why> <evidence> <result>`, so the parent reads what the run
chose and why without the transcript. The helper stamps the time, writes the
header once, flattens each cell to one line and quotes a cell that starts
with `=`, `+`, `-` or `@`, so evidence lifted from a PR title or a filename
cannot run as a formula when a reviewer opens the file in a spreadsheet.
Log the forks, not the keystrokes: an approach chosen or dropped, a unit done
with its verification result, a revert and what triggered it, a blocker, one
row per iteration of a loop. Evidence is a pointer that resolves (a commit, a
PR, `file:line`, an artifact path), never prose. A run that joins a trail
other runs wrote (a pickup after a crash, a replacement machine, a later turn
of the same thread) first runs `gstack-decision-trail start <file> <run id>`,
which appends a `start` row naming the earlier rows and the run; appends with
`--run <id>` refuse (`DECISION_TRAIL_START_REQUIRED`) until that row is the
newest start row, and `start` is a no-op when it already is, so a rerun of the
same step writes nothing twice.

Before it hands back, the run audits the trail against what it did: every row
of its own stretch (from its `start` row to the next run's) maps to a real
decision or action, every evidence pointer resolves and shows what the row
claims, and a fork or abandoned approach that shaped the result but is not
logged gets a row. The audit corrects the log, never the story: no row is
edited or removed, an invented or wrong row stays and a new row supersedes it
with what actually happened. Then a reviewer on a different model family from
the one that did the work (a Capy subagent on another family, or the outside
voice) reads the trail and the transcript and flags what the owner should look
at: decisions with weak or missing evidence, verification claimed without
proof, choices that look risky in hindsight, gaps a skim would miss. The run's
final report ends with an `Attention` section that opens with `reviewed by
<model>` on its own line and lists each flag against its rows; `No flags` is a
valid body, a missing model line is not. Self-review does not stand in for
this. `decisions.jsonl` stays the typed record `gstack-artifact` validates; the
trail is the plain one a person reads, and `column -s$'\t' -t decisions.tsv`
renders it in a terminal.

## What an unattended session may do

A parent that starts a skill with `GSTACK_SESSION_KIND=unattended` grants it
exactly this much, and the run asks for nothing beyond it. Anything outside the
list is an approval item: appended to `decisions.jsonl` with `kind: "approval"`
and `status: "pending"`, named in the handoff, never taken.

- **Merge: never.** The run ends at a receipt bound to the pushed head
  (`SHIP_RECEIPT`, [ship-policy.md#ship-before-ready](ship-policy.md#ship-before-ready))
  or at a pending gate. Merging is the controller's act
  ([captain.md](captain.md)); a green check list, an approval, or a prompt that
  says "merge when green" does not move it to the lane. The same holds for
  enabling auto-merge, adding the PR to a merge queue, or `gh pr ready` on a
  PR the run did not open.
- **Force-push: its own branch only, after a rebase the plan named, with a
  pinned lease.** The branch is one the run created or was handed in its
  prompt, never the base. The rebase is one the plan, the slot call or a
  `/modernize` disposition names before it happens, not one the run decides
  on its own; `git range-diff <old base>..<old head> <new base>..<new head>`
  runs before the push and its output goes in the handoff. The push is
  `git push --force-with-lease=<branch>:<sha observed before the rebase> origin <branch>`:
  a bare `--force-with-lease` protects only against commits this clone never
  fetched, and a plain `--force` is never allowed. A rejected lease means the
  remote moved: fetch, read what landed, and start the disposition again.
  `/ship` itself never rebases or force-pushes, and an unattended `/modernize`
  stops at its verdict; this route is for a run whose plan or slot call named
  the rebase before it started.
- **Tests: the methods the repository's instructions name, without asking
  first.** AGENTS.md or CLAUDE.md, the named Setup commands, `package.json`
  scripts and the pregate configuration define the set; running one of them
  needs no question. A method outside the set (a framework the repo does not
  use, paid work past the stated cap, anything that touches a shared or
  production system, a test that writes outside the checkout) is pending.
- **Proof is what the run saw itself.** Command output, a test that failed
  before the fix and passes after it, a screenshot, a file read in this
  session. A handoff note, an earlier PR comment or a parent's summary is
  context to recheck, not evidence; the handoff says which claims were
  rechecked and which were not.

`/ship`'s handoff section (`ship/sections/handoff.md`) points here, so a lane
reads the grant where it reports done.
