# /ship token budget and fresh-context handoffs

`/ship --token-cap 25M` (or `GSTACK_SHIP_TOKEN_CAP=25M`) bounds what one /ship run spends, and
long runs hand their heavy segments to fresh-context children. The helper is
`bin/gstack-ship-budget`; the skill's procedure is `ship/sections/budget-handoff.md`.
There is no default cap: without one, /ship meters usage when it can and prints it, and
nothing else changes.

## What the cap guarantees

It is an **admission cap**, not a hard ceiling. Before every step and every dispatch batch,
`check` admits the work only when

    used + open reservations + unknown charges + projection + tail reserve + stop overhead <= cap

Exactly at the cap is admitted; one token over is not. A parallel review batch is reserved as
one sum before any of it starts. Admitted work can still cost more than its projection, and
gstack cannot stop a host mid-turn from bash, so a run can finish above the cap by the
misprojection of work already admitted. The tail reserve (default 2M, `--reserve <n>`) keeps
room for the receipt steps, and the stop overhead (calibrated) keeps room to stop cleanly. Once
the run has measured a step, the tail reserve scales with its measured step cost (a `--reserve`
you set stays as given); the stop overhead never scales.

## Observe mode (ship/DRIVER.md)

`start --mode observe` turns the ledger into a record. No step or dispatch is admitted, reserved or
delegated, so a run spends no call on the meter: each program the driver runs ends with

    gstack-ship-budget note --run <id> --step <last step> [--label <what ran>] --reading <tokens> --credits <credits> \
      [--dispatched-at <tokens before the readers> --dispatched-credits <credits before> --readers <n>]

which prints `NOTE: <step>[:<label>] used=<n> credits=<c> [readers=<n> readers_tokens=<n> readers_credits=<c>]`
and the `BUDGET:` line. The cap is one hard stop: a note (or a check) whose `used + unknown` is past
`--token-cap` prints the stop block and exits 3, and nothing else stops the run. No review-log marker
is written, so `gstack-review-log --start` takes no `--reservation`, and `close` audits no
unreserved dispatch. `close` prints `BUDGET_TIMELINE:`, one entry per note. The admission mode
below is what `ship/SKILL.md` runs; it is unchanged.

A dotted `--step` such as `9.1` records under its parent step (`9`) with the sub-step as its label,
unless `--label` is given.

**Counting calls.** `gstack-ship-budget calls --events <file> [--since <iso>] [--until <iso>]` reads
the host's transcript items (a JSON array, or `{ "items": [...] }` as Capy's `tools.thread.get`
transcript returns) and prints
`CALLS: total= decision= keepalive= idle_gaps_over_300s= max_gap_s= first= last= source=`. Every tool
item is one parent call; a `wait`, or a program that only reads status (plus at most one bash for its
note), is a keep-alive, and a gap over 300 s between calls outlives the prompt cache
(`lib/ship-calls.ts`).

**Credits.** Every command that takes `--reading` also takes `--credits <cost.credits>` from the
same `thread.get`. Tokens count a cached read the same as a fresh one; credits are what the run
costs, including the full-context re-bill after a gap over five minutes (about 40x a cached call,
handoffs/GSTA-167/cache-probe.md). The first credits reading is the baseline; the `BUDGET:`,
`BUDGET_FINAL:` and record-block lines print `credits=<used>` once one exists, and a reading below
the last is refused like a token reading ([BUDGET_READING_REJECTED](troubleshooting.md#budget-reading-rejected)).

## Quickstart

**Capy.** Read your own jam's counter inside the execute program that runs the command, never as a
call of its own:

```js
const n = (await tools.thread.get({ thread_id: "<your own jam id>" })).cost.tokens;
```

then pass it to

```bash
gstack-ship-budget start --record <record> --token-cap 25M --reading <n>
gstack-ship-budget check --run <id> --step 6 --next 7 --reading <n> [--prior-reading <n from your previous call>]
```

`--prior-reading` must come from the call just before this one; a prior older than the run's last
reading spans several calls, so it is ignored (`CALL_UNKNOWN:`, `call=unknown`). Two readings in
one program measure nothing: Capy books a call after its program ends.

A jam's own counter includes its own subagents, outside voices too (measured 2026-10-30: +10.92M
across a six-reader dispatch with two ~0.35M parent calls between). `"this"` is the root thread,
whose counter also holds every sibling tree, so a subagent running /ship passes its own jam id;
a root thread's own jam id is its `"this"`. A Capy handoff child cannot read its own jam id, so it
verifies with no reading and prints `METER: parent`; the parent's handoff and reconcile readings,
taken on its own counter (which holds the child), measure it.

**Claude Code.** `gstack-ship-budget start --record <record> --token-cap 25M --session <id>`. Without the
session id, `start --meter claude` prints a nonce: echo it once, then rerun with `--nonce <value>`.
The helper reads the session journal, its subagent journals and the journals of headless
children it launched; you never pass `--reading`.

**Anywhere else.** `--meter estimate` projects with the calibration and prints `meter=estimate`.
With a cap set and no readable meter, start refuses
([BUDGET_METER_UNAVAILABLE](troubleshooting.md#budget-meter-unavailable)).

## The BUDGET line

    BUDGET: used=<n> reserved=<n> unknown=<n> admission_cap=<n|none> tail=<n> unit=<u> meter=<m> epoch=<n> call=<n|unknown> call_floor=<n> above_floor=<n|unknown> next=<id> projected=<n> calibration=step:<f|prior>,dispatch:<f|prior> verdict=continue|delegate|stop

| Field | Meaning |
|---|---|
| `used` | Metered usage since start (all epochs), or settled estimates under `meter=estimate` |
| `reserved` | Open reservations: admitted steps, started dispatches, and each open child's sub-cap counted as max(sub_cap, child_used), never both |
| `unknown` | Charges the meter cannot see (an external-CLI outside voice on Claude Code), counted at their reservation |
| `admission_cap` | The cap, or `none` |
| `tail` | Tail reserve (scaled by the step factor once measured) plus stop overhead, held back from every admission |
| `unit`, `meter`, `epoch` | The meter contract: `capy-tokens` (the agent's own jam counter, subagents included), `claude-usage-tokens` (journal usage), `estimate-tokens`; a meter change opens a new epoch |
| `call` | The per-call charge: two Capy readings in consecutive calls (a prior older than the run's last reading is ignored), or the last Claude Code call's usage |
| `call_floor`, `above_floor` | The host's per-call floor (see Delegation) and the charge above it, max(0, call − floor); the delegate rule compares `above_floor` |
| `next`, `projected` | What the check was for and its projection: the prior times the run's factor for that kind |
| `calibration` | The run's step and dispatch factors (see Calibration), or `prior` before the first measurement |
| `verdict` | `continue` (exit 0, prints `RESERVATION:` and the bare id as `RESERVATION_ID: <id>` under a cap), `delegate` (exit 0), `stop` (exit 3) |

Any exit other than 0 means the next step does not start. Exit 2 is a usage or validation
error on stderr with the code, the value and the repair. GSTACK_RESULT appears only on a stop,
an incomplete close and a child's return; /ship's real terminal line stays Step 22's.

## Dispatches

Under a cap, `gstack-review-log --start` refuses a dispatch without an unspent, one-shot
reservation ([BUDGET_CHECK_SKIPPED](troubleshooting.md#budget-check-skipped)):

```bash
gstack-ship-budget check --run <id> --step 9 --next dispatch:specialist,red-team --reading <n>
gstack-review-log --start review --reservation <id>
```

Name one role per `DISPATCH:` line (six specialists are `specialist` six times): drift and the
measured means are per reader. A reader's prior is the calibrated per-dispatch constant. The run's dispatch factor scales that prior, but never above
the larger of the prior and the run's clean per-reader mean, and the price never drops below the
role's own measured mean. When the whole batch does not fit, `check` admits the largest prefix that does and
prints `ADMIT: k of n (remaining=<roles>)`: dispatch those k, then re-check the remaining roles
once they settle. Only a batch whose first reader does not fit stops, and `close` flags remaining
roles no later check requested (`DROPPED:`, status=incomplete until the owner accepts).
Roles are review-depth's: `specialist`, `red-team`, `adversarial-native`, `outside-voice`,
`fix-check`, plus `docs`, the Step 14.5 documentation audit, which takes no review-log start and
settles in its program like the others. `--finish <token>` is the pass's completion receipt: it settles that reservation and
every other dispatch reservation started in the same step, so reviewers admitted one at a time
do not stay reserved. The program that dispatches a batch measures it: it reads the counter right
before it starts the readers and again right after the last one settles, then runs `settle
--reservation <id> --dispatched-at <before> --reading <after> --readers <n>` (or names the batch in
a check with `--returned <id> --dispatched-at <before>`). The parent makes no model call inside that
program, so the pair holds only the readers. A check that moves to the next step settles every
dispatch a reviewer started in the step before. Only that pair is measured: `--finish`, a step
change, `--returned` or a settle without `--dispatched-at` (a later program), and a
`--dispatched-at` older than another command's reading, all settle without measuring, print
`UNMEASURED:` and leave the factor alone (their interval also holds the parent's own work).
`close` audits after the fact: each review-log row of the run with no reservation gets one
BUDGET_CHECK_SKIPPED line and the run ends status=incomplete for the owner to accept
(`close --approved-by <who> --words "<their words>"`); a reservation is never created after the fact.

## Delegation

The delegate rule measures context above the host's per-call floor: what one call costs in a
fresh session with the ship skill loaded, before any /ship work. The floor is `call_floor` per
unit in `lib/ship-budget-calibration.json` (150k on Capy, where a fresh thread's calls cost
150–230k; 40k on Claude Code; 0 for the estimate meter, whose charge is always unknown), or
`start --call-floor <n>`, which the ledger records and every child inherits. At start, 100k or
more above the floor delegates the whole /ship. Before Step 9 and before Step 12, 150k or more
above the floor (or an unknown charge) delegates the next segment (9–11.5, 12–22). The BUDGET
line prints `call`, `call_floor` and `above_floor`, so each verdict can be checked:

1. `gstack-ship-budget handoff --run <id> --from 12 --to 22 --base origin/<base> --reading <n>` writes a
   brief (mode 0600, under the run directory) with the pins (HEAD, merge base, working tree,
   reviewed tree), the record with its six headings and start tokens, the decisions in scope
   with the owner's words, the decision trail, the budget and the return contract. Its `READ:`
   lines are the child's whole reading list as line ranges: ship/SKILL.md's contract, the
   segment's own steps, the self-check and Important Rules (never the preamble or section
   index), and each segment section whole, so every reviewer brief is the section's own text.
   The return contract names `--to` as the
   segment's last step, so a 12-22 child returns `--to 22`. It reserves
   the child's sub-cap: min(cap − used − reserved − unknown − the calibrated tail reserve and stop
   overhead, the segment estimate), or `--sub-cap`. A child handing off reserves its whole
   remaining sub-cap instead (cap − used − reserved − unknown − its stop overhead).
2. The child is a Capy subagent on the shared machine, or on Claude Code
   `gstack-ship-budget launch --in <brief>`: a background `claude -p` (resolved through lib/claude-bin.ts)
   with explicit permission flags and the return file named.
3. The child runs `verify-handoff` first; a moved pin refuses
   ([HANDOFF_PIN_MOVED](troubleshooting.md#handoff-pin-moved)). It admits against its sub-cap
   with child_used = its own counter's reading − its reading at `verify-handoff` (a parent-metered
   Capy child takes no reading, never delegates on an unknown charge, and returns `METER: parent`,
   so `reconcile` charges the parent's counter delta since `handoff`) and is the only
   writer of the record; `reconcile` records the `BUDGET used=` its return prints as the
   handoff's child_used and settles its reservation (only `meter=estimate` adds it to the
   parent's used; the Capy and Claude Code meters already hold it, step 4). The
   context rule never stops a child. When it fires at one of the child's boundaries:
   - once the child has completed a step since `verify-handoff`, `verdict=delegate` hands its
     remaining steps (the next step through the end of its segment) to a fresh grandchild
     through these same four steps. The chain depth (1 for a child, 2 for a grandchild, at most
     3) is recorded in the brief, the handoff and the new ledger;
   - before its first completed step, at depth 3, or when the next step is past its segment,
     `verdict=continue` with one `CONTEXT_HIGH:` line (call, floor, threshold, depth, reason).

   The admission cap still stops a child (`reason=budget_exhausted`). It reconciles any
   grandchild, then ends with `return` (at most 40 lines). `return` reports `status=incomplete`
   while one of the child's own handoffs is unreconciled (`UNRECONCILED:`) or an ADMIT remainder
   was never re-checked (`DROPPED:`), so a delegated segment cannot drop readers or leave a
   grandchild writing after the parent moves on.
4. `gstack-ship-budget reconcile --run <id> --return <file> --reading <n>`; idempotent per handoff hash,
   so a duplicate return charges nothing twice. A refused, incomplete or interrupted child
   exits 3 and stops the run (`reason=child_<status>`): every check refuses until a regenerated
   child reconciles complete or `resume` runs; regenerate the handoff or stop. Up a chain each token is charged once: the Capy
   counter already includes the whole subtree, a session `launch` starts joins the Claude Code
   meter of every ancestor, and under `meter=estimate` a child's returned `used` carries its
   grandchild's.

`--delegate never` turns delegate into stop for a parent on a host without children; a child
continues with a `CONTEXT_HIGH:` note instead.

**Small runs keep their segment.** `check --runtime-lines <n>` (runtime_lines from
`gstack-review-plan --json`, which `gstack-ship-preflight` prints) continues at the Step 9 and
Step 12 boundaries, with a `SMALL_RUN:` line, when the diff is light (at most 50 runtime lines)
and the segment's calibrated calls at this run's per-call charge cost at most 12M. A child costs
a fixed 2–4.5M (gstack-evals #34: boot, install check, verify-handoff, section reads,
reconcile) and saves at most about 3/8 of each parent call, so a segment under 4.5M ÷ 0.375
cannot pay for one. Without the flag the rule above applies unchanged.

## Stop and resume

A stop prints

    STOP: reason=budget_exhausted spent=<n> reserved=<n> unknown=<n> admission_cap=<n> next=<id> projected=<n>
    RECOVER: /ship --resume <record> --token-cap <used + reserved + unknown + projected tail>
    GSTACK_RESULT: skill=ship status=incomplete run=<dir>

Raising the cap is the owner's call; the resume journals who raised it and their words:

```bash
gstack-ship-budget resume --record <record> --token-cap <n> --approved-by Garry --words "raise it to finish" --reading <n>
```

Every command takes `--run` or `--record`; runs are never found by branch or directory, and a
/ship without `--resume` or `--continue` always starts a new run. The ledger and record are
mirrored to a private Drive checkpoint (`GSTACK_SHIP_BUDGET_CHECKPOINT_DIR`, else the
project-user Drive folder on Capy) bound to the run id and their hashes, so after a machine
change `resume --run <id>` restores both. A corrupt ledger
([BUDGET_LEDGER_INVALID](troubleshooting.md#budget-ledger-invalid)) is rebuilt from the
record's block with `--rebuild-from-record`; open reservations are then charged as unknown.

## Calibration

`lib/ship-budget-calibration.json` holds per-meter constants (per call, per dispatch, stop
overhead, calls and dispatches per step) fitted from metered runs: each constant is the
largest observation times 1.5, rounded up to 10,000 tokens. The leave-one-out test
(test/ship-budget-calibration.test.ts) covers the per-call constant only, the one observed
across three runs; per-dispatch has two observations and stop overhead one. Only the Capy
meter has observations; the Claude Code and estimate units are seeded from it until a
Claude-metered /ship completes. Each unit's `call_floor` is calibrated separately, with its
evidence in `call_floor_why`; a floor is the largest 10,000 multiple at or below its smallest
observed fresh call.

These constants are the prior. A dispatch is measured from its dispatch program's
`--dispatched-at` reading to the reading it was settled with in that program (dispatches with one
pair split it per reader, `--readers` or one per role). A step is
measured at the next step change, from its check's reading minus the dispatches reserved inside
it, so the parent's interleaved calls stay in the step; a step holding an unmeasured dispatch is
not measured. Each measurement prints

    DRIFT: id=<reservation> kind=step|dispatch next=<id> projected=<n> actual=<n> ratio=<actual/projected>

and each reservation that cannot be measured prints
`UNMEASURED: id=<reservation> kind=step|dispatch next=<id> reason=settled_without_reading|no_dispatch_reading|reading_between|dispatch_unmeasured`.

From then on the run projects steps and dispatches with its own factor: the largest
actual/prior ratio among its last three measurements of that kind, times 1.5. The step factor
also scales the default tail reserve. Dispatches keep the prior until the first
dispatch is measured, so under a tight cap admit one reviewer first and let it calibrate the rest.
On the Capy meter a step's prior is its calibrated call count (`step_calls`) times the run's own
median per-call charge over its last five measured calls (each `--reading` minus a fresh
`--prior-reading`), once three are measured, unscaled (`calibration=…,call:<median>`); until then
it uses the calibrated `per_call`. A step prior never carries a dispatch: each audit or reviewer
batch is reserved by its own check, and a child's segment estimate counts them through
`segment_dispatches`.
`close` prints `BUDGET_DRIFT:` with the run's projected and actual totals per kind. The estimate
meter has no readings, so it always projects at the prior.

## Token cap and USD spend cap

A lane's `--spend-cap` (USD) bounds paid gates and evals through lib/spend-ledger.ts; `--token-cap`
bounds the /ship run's model tokens through its own ledger. They are independent: set both
when a lane runs paid gates inside /ship, and neither converts into the other.

## Claiming savings

Savings count completed ships only. Preregister the comparison with `/eval-plan` (arms, bars,
stop rules) before claiming a saving from the cap or from delegation.

## Result codes

[BUDGET_CAP_REACHED](troubleshooting.md#budget-cap-reached) ·
[BUDGET_READING_MISSING](troubleshooting.md#budget-reading-missing) ·
[BUDGET_READING_REJECTED](troubleshooting.md#budget-reading-rejected) ·
[BUDGET_METER_UNAVAILABLE](troubleshooting.md#budget-meter-unavailable) ·
[BUDGET_LEDGER_INVALID](troubleshooting.md#budget-ledger-invalid) ·
[BUDGET_CHECK_SKIPPED](troubleshooting.md#budget-check-skipped) ·
[HANDOFF_PIN_MOVED](troubleshooting.md#handoff-pin-moved)
