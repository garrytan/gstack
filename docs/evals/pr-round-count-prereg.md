# Prereg: does a scoped re-check reader lose blockers that a full round would catch? (GST-2673)

Status: locked 2026-11-13, before any paid call. Owner: GStack Minder (GSTA-36). Runs once, on the branch that adds
the per-PR round count ([review-policy.md](../review-policy.md#rounds-per-pull-request)), before that branch merges.

## Question
Once a pull request has had a full review round, design A sends each new head to one scoped re-check reader that
sees only what changed since the last reviewed head (the [carry re-check](../troubleshooting.md#receipt-carry-recheck)
packet), instead of a fresh full round. Does that reader still find the blocking faults that review fixes create
after round 1, and stay quiet on heads that had none?

Where the evidence comes from: one crew working on an internal product had three heavily reviewed PRs whose later
rounds raised dozens of findings. A small share led to a real code fix, and most of those repaired a fault created
after round 2 inside the diff since the previous head, which is the scoped reader's range. One more fault, a race a
round-1 fix created, sat outside that range. That crew, its product and its repository are not named here; its
packets and labels stay private, and this repository reports only aggregates.

## The decision this changes (R97)
If the scoped reader keeps the blockers (Part 2's bars met), later heads go to the scoped re-check by default and
this branch merges as built. If it loses them, the branch does not merge as built: later heads keep a full round
(the count and stop rule stay, the re-check route is narrowed or widened first) and the loss is reported. Part 1
decides the drift threshold the router ships with.

## Part 1: free deterministic replay (no model calls)
Over every PR body with receipts in gstack and in the source crew's repository (read only), run the new counter
and router (`lib/pr-review-history.ts`, `reviewRoute`) head by head and record:
1. Route labels for every later head: re-check eligible, re-check refused (with carry's reason), re-check found a
   blocker then a full /ship ran, a run stopped with no receipt, or the lane ignored the route.
2. Rounds: on PRs with three or more /ship runs, at most two full rounds planned; on one-run PRs, no plan change.
3. Drift: how often `PR_DRIFT_LINES` (400) fires and at which head. If a value between 200 and 800 would send the
   known out-of-range fault to a full round without firing on more than a quarter of the multi-head PRs, that value
   replaces 400 before Part 2 runs, and the change is recorded in the results.
4. Coverage, scored on each labelled fault's cause line: whether that line sits inside the packet design A builds.

## Part 2: paid scoped-reader replay (no-loss)
**Cases.** 48 packets, each the packet `gstack-ship-receipt carry` writes (`crew/lib/ship-recheck.ts`
`recheckPacket`, the text on this branch) for one later head:
- 32 positives: every in-range fix-made fault from the source sample (fewer than ten), plus faults seeded into fix
  ranges of gstack's own public PRs to make 32. A seeded fault is one edit in a later head's own range, of a class
  a test would catch or production would feel (an inverted condition, an off-by-one, a dropped error path, a wrong
  variable, a missing await, a lost write). A separate subagent seeds them; each label (path, line, cause, and
  two to four cause words) is written and committed to the private label file before any reader runs.
- 16 controls: later heads whose round found only notes, from the source sample and from gstack's PRs.
- The out-of-range race is a known miss: listed in the results, not scored.

**Reader.** The lane model, Claude Opus 5.5, through the Messages API with the packet as the whole prompt and no
tool or repository access, plus one fixed output line: "List each blocking finding on its own line as BLOCKING:
<path>:<line> <cause>, then the record." This reads less than a real reader, which can open files, so a loss here
is an upper bound on the real one. A model refusal is a result, never a swap (R95).

**Kind and trials.** `behavior`: 3 independent trials per packet. A positive passes when at least 2 of 3 trials
list a BLOCKING line within 3 lines of the labelled line in the labelled path, carrying at least one of its cause
words. A control fails when at least 2 of 3 trials list any BLOCKING line. Matching is a script, not a judge.

**Bars, fixed now.**
1. Recall on the 32 positives at least 0.85, reported with its 95% Wilson interval. The smallest difference this size
   can tell apart from the bar is about 0.15.
2. At most 2 of 16 controls fail, with the 95% interval of the control failure rate.
3. Paired, on the real faults: each fault's scoped-reader result beside the later full round that found it (a full
   round found every one, by construction), with the paired difference and its 95% interval. No bar: too few faults.

**Verdict.** Both bars met: KEEP the scoped re-check as the default for later heads. Recall below the bar or more
than 2 controls failing: FIX-METHOD (widen the packet or send those heads to a full round), after one "Why null?"
cycle (did the reader read the range, do the faults fit it, is n enough, does a full round see what it missed).

**Reruns.** None, except the one AGENTS.md allows: a red case may be rerun once at the same packet as a new panel
of 3; a pass is green with a flaky note and a red is real. Harness and infrastructure failures never rerun.

**Budget.** 144 dispatches at about $1 each, capped at $160 including any rerun. A cap stop ends the run
incomplete with every finished case reported.

## After merge (separate brief)
A free 7-day before-and-after on full rounds per PR, re-checks per PR and /ship runs per PR (with each window's daily
spread), and a paid escape audit on merged PRs whose later code only re-checks read, under its own prereg. The
ledger row is `ship-review-panel` in `docs/inventory/evidence.json`; measure by 2026-12-08.
