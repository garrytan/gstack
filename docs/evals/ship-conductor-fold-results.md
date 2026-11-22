# Does /ship need its conductor subagent? Results (GST-3003)

We learned that Claude Opus 5.5 can run gstack's /ship procedure itself, in the pull request's own thread, with no
separate conductor subagent in between: over 10 cases and 30 paired runs of the review and fix phases, this run found
no clear difference in cost, planted bugs caught or real problems found. **The verdict depends on one scoring ruling
made after seeing data**: under it, every preregistered bar passes and the conductor goes; under the plan's literal
wording, one run misses the reader-fidelity bar (29 of 30) and the conductor stays. You should treat this as a cut
candidate with both readings, not a clean result.

We also learned that a plain review prompt with no gstack caught 16 of 30 planted bugs against /ship's 21 and 22 of
30, at about a fourteenth of the cost. The paired interval of that gap only just reaches zero, so the plan sends
/ship's review panel to its own "Why null?" check.

Preregistration: [ship-conductor-fold-prereg.md](ship-conductor-fold-prereg.md), frozen 2026-11-17 and amended four
times before any counted run. Every interval below is the plan's paired interval by case, with the end-of-run critical
value t = 2.291 (10 cases), except where a row says otherwise: the 9-case sensitivity row uses t = 2.336, and the
real-problem figures, which cover the 6 cases that have a real problem, use t = 2.609.

## What worked

- **The folded procedure ran as written.** In all 30 F runs the thread ran /ship's phases itself and started every
  reviewer itself; none handed /ship to a subagent. Under the ruling below, every reviewer the printed review plan
  named and /ship reached was started and collected in 30 of 30 runs (hand-scored, and confirmed run by run by a
  second-model checker).
- **No clear difference in cost.** F minus C was +$0.07 a run (-$1.42 to +$1.57), against a planned detectable difference of
  about $7. Mean cost was $11.47 for C and $11.54 for F.
- **No clear difference in what it caught.** Planted bugs: F minus C +0.03 (-0.18 to +0.24), 22 of 30 for F against 21 of 30 for C.
  Real problems found by the judge: F minus C -0.03 (-0.37 to +0.32), over the 6 cases with one (corrected; see
  below). No case was a structural loss (C catching in
  all three runs and F in none) on either measure.
- **No clear difference in time.** Wall time F minus C was -1.9 minutes (-8.1 to +4.4), and `calls=` +0.35 (-2.8 to +3.5),
  both diagnostics with no bar.

## What didn't

- **The fidelity bar passes only under a ruling made after seeing the data.** In F7t3, /ship stopped itself at the
  Step 9.4 round cap (`NEXT: stop`), before Step 11, where the two voices its last full-pass plan named would run.
  The run skipped nothing it was supposed to reach. The owner ruled that a named reviewer counts only if /ship
  reached the step where it runs, and applied that rule to every later run, C and F. The checker dissented: line 193
  says "named", not "due before the stop". Read literally, F7t3 is a miss, fidelity is 29 of 30, and the plan's
  decision is that the conductor stays with one FIX-METHOD cycle for the fold's reviewer dispatch.
- **Leaving out the exposure-flagged runs changes one case.** Nine of 30 F runs were flagged for exposure: most looked
  at `origin/main`'s version of the planted file, and the rest saw only file names or summaries that mention this plan
  (below). Repeating the bars without them leaves 9 cases (all three of case 7's F runs drop out). Cost
  and real problems still pass, but case 9 becomes C 3 of 3 against F's one remaining run, which missed. The
  script's per-case mean counts that as a structural loss, but the frozen rule needs F to miss in all 3 runs, so
  with one F run left the case is not assessable and there is no preregistered failure; it is reported, not decided on.
- **The no-gstack arm came close on planted bugs at a fraction of the cost.** N minus F (the better /ship arm) was
  -0.20 on planted bugs (-0.40 to +0.004) and -0.04 on real problems (-0.31 to +0.23), at $0.83 a run. An earlier
  version of this page said N led on real problems; that came from counting its restatements of the planted bug as
  other problems, and it does not hold (below). Its harness differs (below), so cost compares in size only.
- **Almost no run reached the end of /ship.** Only 9 of 60 C and F runs printed a receipt (4 C, 5 F). Of the other
  51, 35 stopped during review (Steps 9 to 11), 33 of them at /ship's own two-round cap; 8 at finish's remote-gate
  refusal on a non-main base (Step 16), where the brief ends the run; 6 at the same refusal one step later, at accept
  (Step 17); 1 when the receipt write refused (Step 19); and 1 at a paid-eval spend question before review began.
  So this compares the review and fix phases, not the release steps after them.

## Results

| Arm | Label | Runs | Planted bugs caught | Real-problem catch rate (mean over the 6 cases with one) | Mean cost a run | Mean wall time | Reader fidelity |
|---|---|---|---|---|---|---|---|
| `claude-opus-5-5#ship-conductor` | C | 30 | 21 of 30 | 0.26 | $11.47 | 38.5 min | not scored (C is the reference) |
| `claude-opus-5-5#ship-folded` | F | 30 | 22 of 30 | 0.23 | $11.54 | 36.6 min | 30 of 30 under the ruling, 29 of 30 literal |
| `claude-opus-5-5#no-gstack` | N | 30 | 16 of 30 | 0.19 | $0.83 | 6.6 min (SDK runs) | not applicable |

| Bar (F minus C) | Owner's ruling (made after seeing data) | Literal line 193 (as frozen) | Without the 9 exposure-flagged F runs (9 cases, t = 2.336) |
|---|---|---|---|
| Cost a run | +$0.07 (-$1.42 to +$1.57), pass | same, pass | +$0.01 (-$1.62 to +$1.64), pass |
| Planted-bug catch rate | +0.03 (-0.18 to +0.24), pass | same, pass | -0.04 (-0.39 to +0.32), not assessable: one F run left (a miss); no preregistered failure |
| Real-problem catch rate (6 cases, t = 2.609) | -0.03 (-0.37 to +0.32), pass; at t = 2.291: -0.33 to +0.27 | same, pass | -0.03 (-0.37 to +0.32), pass; at t = 2.336: -0.34 to +0.28 |
| Reader fidelity | 30 of 30, pass | 29 of 30, fails | pass under the ruling |
| Decision | conductor goes | conductor stays, one FIX-METHOD cycle | not a decision row |

Per case, each cell is that arm's three runs:

| Case | C planted | F planted | N planted | C real | F real | N real | C cost | F cost | N cost |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 of 3 | 2 of 3 | 1 of 3 | 0.33 | 0.33 | 0.33 | $14.45 | $15.02 | $1.78 |
| 2 | 1 of 3 | 3 of 3 | 1 of 3 | 0.17 | none found | 0.17 | $15.37 | $12.54 | $1.75 |
| 3 | 3 of 3 | 3 of 3 | 3 of 3 | 0.17 | 0.33 | none found | $13.15 | $12.28 | $0.74 |
| 4 | 1 of 3 | none of 3 | none of 3 | 0.33 | none found | 0.33 | $8.37 | $11.04 | $0.89 |
| 5 | 3 of 3 | 3 of 3 | 3 of 3 | no real problem | no real problem | no real problem | $11.82 | $12.90 | $0.55 |
| 6 | 3 of 3 | 3 of 3 | 2 of 3 | 0.56 | 0.22 | none found | $9.31 | $11.05 | $0.71 |
| 7 | 3 of 3 | 3 of 3 | 1 of 3 | no real problem | no real problem | no real problem | $12.90 | $12.57 | $0.67 |
| 8 | none of 3 | none of 3 | none of 3 | none found | 0.50 | 0.33 | $11.35 | $7.61 | $0.43 |
| 9 | 3 of 3 | 2 of 3 | 2 of 3 | no real problem | no real problem | no real problem | $8.80 | $10.69 | $0.46 |
| 10 | 3 of 3 | 3 of 3 | 3 of 3 | no real problem | no real problem | no real problem | $9.17 | $9.71 | $0.33 |

Real-problem rates are the share of the case's judged-real problems (the union over every arm and run, with
restatements of the planted bug removed) that a run found, averaged over the three runs. Cases 5, 7, 9 and 10 have
no real problem left after that correction. Every arm missed case 8's planted bug in every run; a hand read found no near
misses. N's case 4 runs hit a full disk on the runner during `bun install` and were not rerun, as the stop rules
require; their reviews ran and are counted.

<details><summary>Every trial</summary>

Trial names are arm, case and run (C4t2 is the conductor arm's second run on case 4). Cost is cost.dollars for C and
F and the SDK's reported total for N. "Where the run ended" is read by hand from each run's own report. "Exposure flag" marks the runs in the
sensitivity row above; N4's are the
harness failure.

| Trial | Planted bug caught | Cost | Where the run ended | Exposure flag |
|---|---|---|---|---|
| C1t1 | no | $12.00 | review round cap (Steps 9 to 11) | no |
| C1t2 | no | $17.90 | receipt | no |
| C1t3 | yes | $13.45 | remote-gate refusal at accept, Step 17 | no |
| F1t1 | no | $10.46 | review round cap (Steps 9 to 11) | no |
| F1t2 | yes | $14.06 | remote-gate refusal, Step 16 | no |
| F1t3 | yes | $20.53 | remote-gate refusal at accept, Step 17 | no |
| N1t1 | no | $1.17 | one SDK review run | no |
| N1t2 | yes | $2.15 | one SDK review run | no |
| N1t3 | no | $2.04 | one SDK review run | no |
| C2t1 | yes | $12.81 | review round cap (Steps 9 to 11) | no |
| C2t2 | no | $10.97 | review round cap (Steps 9 to 11) | no |
| C2t3 | no | $22.33 | remote-gate refusal at accept, Step 17 | no |
| F2t1 | yes | $11.43 | review round cap (Steps 9 to 11) | yes |
| F2t2 | yes | $13.52 | review round cap (Steps 9 to 11) | no |
| F2t3 | yes | $12.67 | review round cap (Steps 9 to 11) | no |
| N2t1 | yes | $2.17 | one SDK review run | no |
| N2t2 | no | $0.85 | one SDK review run | no |
| N2t3 | no | $2.23 | one SDK review run | no |
| C3t1 | yes | $15.83 | remote-gate refusal, Step 16 | no |
| C3t2 | yes | $11.40 | review round cap (Steps 9 to 11) | no |
| C3t3 | yes | $12.22 | review round cap (Steps 9 to 11) | no |
| F3t1 | yes | $12.50 | review round cap (Steps 9 to 11) | no |
| F3t2 | yes | $13.12 | review round cap (Steps 9 to 11) | no |
| F3t3 | yes | $11.22 | review round cap (Steps 9 to 11) | no |
| N3t1 | yes | $1.09 | one SDK review run | no |
| N3t2 | yes | $0.56 | one SDK review run | no |
| N3t3 | yes | $0.58 | one SDK review run | no |
| C4t1 | no | $10.49 | review round cap (Steps 9 to 11) | no |
| C4t2 | yes | $10.90 | review round cap (Steps 9 to 11) | no |
| C4t3 | no | $3.72 | review, Step 9.1 (asked to delete a build artifact) | no |
| F4t1 | no | $11.80 | review round cap (Steps 9 to 11) | no |
| F4t2 | no | $10.28 | review round cap (Steps 9 to 11) | no |
| F4t3 | no | $11.04 | review round cap (Steps 9 to 11) | no |
| N4t1 | no | $0.97 | one SDK review run (runner disk full during bun install) | harness |
| N4t2 | no | $0.74 | one SDK review run (runner disk full during bun install) | harness |
| N4t3 | no | $0.96 | one SDK review run (runner disk full during bun install) | harness |
| C5t1 | yes | $10.94 | review round cap (Steps 9 to 11) | no |
| C5t2 | yes | $12.07 | remote-gate refusal at accept, Step 17 | no |
| C5t3 | yes | $12.46 | remote-gate refusal, Step 16 | no |
| F5t1 | yes | $13.97 | receipt write refused, Step 19 | yes |
| F5t2 | yes | $11.67 | remote-gate refusal, Step 16 | no |
| F5t3 | yes | $13.06 | remote-gate refusal at accept, Step 17 | no |
| N5t1 | yes | $0.52 | one SDK review run | no |
| N5t2 | yes | $0.47 | one SDK review run | no |
| N5t3 | yes | $0.65 | one SDK review run | no |
| C6t1 | yes | $8.62 | review round cap (Steps 9 to 11) | no |
| C6t2 | yes | $9.45 | review round cap (Steps 9 to 11) | no |
| C6t3 | yes | $9.85 | review round cap (Steps 9 to 11) | no |
| F6t1 | yes | $13.06 | receipt | no |
| F6t2 | yes | $10.03 | review round cap (Steps 9 to 11) | no |
| F6t3 | yes | $10.06 | review round cap (Steps 9 to 11) | no |
| N6t1 | yes | $0.83 | one SDK review run | no |
| N6t2 | yes | $0.57 | one SDK review run | no |
| N6t3 | no | $0.74 | one SDK review run | no |
| C7t1 | yes | $13.16 | receipt | no |
| C7t2 | yes | $14.10 | receipt | no |
| C7t3 | yes | $11.45 | remote-gate refusal, Step 16 | no |
| F7t1 | yes | $13.97 | receipt | yes |
| F7t2 | yes | $15.12 | receipt | yes |
| F7t3 | yes | $8.63 | review round cap (Steps 9 to 11) | yes |
| N7t1 | no | $0.64 | one SDK review run | no |
| N7t2 | yes | $0.55 | one SDK review run | no |
| N7t3 | no | $0.81 | one SDK review run | no |
| C8t1 | no | $8.69 | review round cap (Steps 9 to 11) | no |
| C8t2 | no | $13.38 | remote-gate refusal, Step 16 | no |
| C8t3 | no | $11.99 | remote-gate refusal, Step 16 | no |
| F8t1 | no | $11.76 | remote-gate refusal at accept, Step 17 | no |
| F8t2 | no | $9.12 | review round cap (Steps 9 to 11) | no |
| F8t3 | no | $1.96 | paid-eval spend question, Step 6 | no |
| N8t1 | no | $0.41 | one SDK review run | no |
| N8t2 | no | $0.47 | one SDK review run | no |
| N8t3 | no | $0.41 | one SDK review run | no |
| C9t1 | yes | $10.81 | receipt | no |
| C9t2 | yes | $6.76 | review round cap (Steps 9 to 11) | no |
| C9t3 | yes | $8.83 | review round cap (Steps 9 to 11) | no |
| F9t1 | yes | $8.50 | review round cap (Steps 9 to 11) | yes |
| F9t2 | no | $10.81 | receipt | no |
| F9t3 | yes | $12.75 | receipt | yes |
| N9t1 | no | $0.54 | one SDK review run | no |
| N9t2 | yes | $0.41 | one SDK review run | no |
| N9t3 | yes | $0.43 | one SDK review run | no |
| C10t1 | yes | $11.29 | remote-gate refusal, Step 16 | no |
| C10t2 | yes | $8.91 | review round cap (Steps 9 to 11) | no |
| C10t3 | yes | $7.30 | review, Step 9.4 (required-probe gate) | no |
| F10t1 | yes | $10.68 | review round cap (Steps 9 to 11) | yes |
| F10t2 | yes | $9.88 | review round cap (Steps 9 to 11) | yes |
| F10t3 | yes | $8.58 | review round cap (Steps 9 to 11) | no |
| N10t1 | yes | $0.36 | one SDK review run | no |
| N10t2 | yes | $0.29 | one SDK review run | no |
| N10t3 | yes | $0.34 | one SDK review run | no |

</details>

## Why null?

The fold's result is a tie inside the run's resolution, which the plan treats as "the conductor goes" because it
removes one agent layer at no measured loss. The one "Why null?" cycle:

- **Did the runs use the part under test?** Yes. Every C thread handed /ship to one subagent, per its brief; every F
  thread ran /ship itself, which the hand fidelity read checked run by run.
- **Do the tasks fit?** Partly. The cases cover /ship's review and fix phases well, but 51 of 60 runs stopped before
  the receipt, 36 of them before finish, so the release steps were barely exercised by either arm.
- **Enough samples and headroom?** The cost interval (about plus or minus $1.50) is far tighter than the planned $7.
  The catch-rate intervals (about plus or minus 0.2 for planted bugs, 0.35 for real problems) are within the planned
  35 points. Differences smaller than that
  could not be seen. Planted-bug catch rates were 70 to 73 percent, so there was headroom.
- **Does the frontier model already do it unaided?** Yes: that is what F measures, and it held.

Verdict: **CUT-CANDIDATE** for the conductor under the ruling; **FIX-METHOD** under the literal reading. Because the
two readings disagree, the decision goes to the owner with both, as the ruling required.

The no-gstack arm's planted-bug gap to F has an interval that includes zero, at well under a quarter of F's cost, so
the plan gives /ship's review panel one "Why null?" cycle under G3 (which reviewers earn their place). The conductor
decision does not depend on it.

## Departures from the preregistration and corrections

- **Halfway look ran twice.** At cases 1 to 5 the first run printed `chance_conductor_removed=0.0` and
  `stop=true`, from a scorer bug: case 5's fix-check runs at /ship's Step 3.5, outside the pass manifest the scorer
  read. With that fixed, the second run on otherwise byte-identical inputs printed 0.94 and `stop=false` ("continue to
  cases 6-10"). Harm was false both times (cost t = 0.13, planted t = 0.78).
- **Fidelity is hand-scored.** An independent second-model read (GPT-6.2 Sol) rated the repaired fidelity script
  DISAGREE three times in a row, each for edge cases cases 1 to 5 never exercised (standalone voices-only passes, a
  fix-check plan's own voices, tree binding to the Step 11.5 tree, evidence provenance by pass). On the owner's
  standing ruling, all 30 F runs were hand-scored from each run's machine evidence, and the same checker read every
  one and agreed under both readings. The script stays a diagnostic; it also disagrees on F10t1, where Step 11's
  voices ran on the head after a round-two fix, and the checker ruled that a false negative.
- **Evidence limit.** In F5t2, F6t2 and F9t1 the fix-check's collection rests on a review-log record and a finished
  task, with no saved raw output. The checker accepted it.
- **Real problems first left the no-gstack arm out.** The plan makes a case's real problems the union over all arms
  and gives N the same judge. The first judge runs sent only C and F findings. Before the write-up, N's findings were
  added (split with the rule the judge-stage labels used) and the frozen judge was run once more over all 10 cases;
  that run is the basis of the figures above. The C/F-only run gave F minus C -0.035 (-0.32 to +0.25), also a pass
  with no structural loss.
- **Restatements of the planted bug were first counted as real problems (corrected 2026-11-22).** The item builder
  dropped findings that matched the plant by the catch rule (the labelled path, a line within 3 and a cause word), so
  findings that
  described the planted bug but cited another line reached the judge, which labelled them real problems. A second
  look found this after the first version of this page. The fix was a rule written down before any recount (a
  finding that describes the planted defect counts as the plant, whatever line it cites, in every arm alike) and a
  blind classification of all 59 judged-real findings by a second-model checker that saw no arm, trial or cost: 26
  are plant restatements, filling six whole groups (case 3 g4, 5 g1, 6 g1, 7 g1, 9 g1, 10 g1), and no group was
  mixed. That matches the earlier post-hoc read group for group. Planted-bug catches are unchanged. As published,
  then corrected: real-problem F minus C -0.003 (-0.21 to +0.20), now -0.03 (-0.37 to +0.32) over 6 cases instead
  of 10; arm means C 0.24, F 0.23, N 0.40, now 0.26, 0.23 and 0.19; N minus F +0.17 (-0.19 to +0.53), now -0.04
  (-0.31 to +0.23); sensitivity row -0.04 (-0.25 to +0.17), now -0.03 (-0.37 to +0.32). These intervals use the
  critical value for the 6 cases that remain (t = 2.609 at the plan's end-of-run p of 0.047704). The frozen
  script's method takes the critical value from the number of cases in the whole comparison (10, or 9 in the
  sensitivity row), not from the 6 cases with a real problem, which gives narrower intervals for the same data: F
  minus C -0.33 to +0.27 and N minus F -0.27 to +0.20 at t = 2.291, and the sensitivity row -0.34 to +0.28 at
  t = 2.336. The bars table shows both.
  Under either, the bar still passes with no structural loss, and the conductor decision does not change.
- **Exposure.** Every C and F run was audited for reads of crew notes, this plan, the label file, and history or
  diffs against `origin/main` on the planted path. Nine F runs are flagged: F2t1 and F5t1 saw only file names, line
  counts or a one-line changelog summary that mention this plan; F7t1-3, F9t1, F9t3, F10t1 and F10t2 looked at main's version of the planted
  file. In five of those seven the plant was already caught before the lookup; in F9t1 and F9t3 the catch may have
  been informed by main, and F7t2 and F9t1 used main's version as their fix. No audited transcript shows a read of
  this plan's contents or the label file, or a `git log -S`, `git log -p` or `git blame` on a planted file. For C the
  audit covers only the thread: C's /ship runs in a subagent whose tool calls the audit cannot read, so C's exposure
  is undercounted against F's; the sensitivity row above leaves out F runs only, which tilts it against F.
- **Cost far below plan.** Runs cost about $11.50, not the planned $38, because they stop at the round cap or the
  Step 16 refusal; the profile's $34.66 came from complete runs.
- **No-gstack harness.** N runs in the Claude Agent SDK (the `claude_code` preset) in a container on the runner's
  Capy machine with no drive mounted, with bun and the installed dependencies, as the third amendment records. Its
  cost is the SDK's reported total at list price.
- **Interval for the 9-case sensitivity row.** The end-of-run critical value for 8 degrees of freedom (2.336, at the
  same two-sided p of 0.047704) was computed by numerical integration in the analysis script.

<details><summary>Agent notes</summary>

Scripts, transcripts and the sealed label file stay private. Frozen hashes: catch.py
9dbb3abf…, look.py 42ec835e…, judge3.py 1640eb6d… (prompt ff56058d…, precedents 430bb246…), label file f1e81ee2….
Judge check: `JUDGE_AGREEMENT: ok judge=gpt-6-astra n=71/48 kappa=0.73 bar=0.6`. Fidelity ruling, scorer history and
the real-problem correction are on GST-3003.

</details>
