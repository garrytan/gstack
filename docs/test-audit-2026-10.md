# Test, eval and CI audit — October 2026

This document records the evidence behind the October 2026 test, eval and CI
wave: the EVAL_POLICY v2 decision memo (D1) with its pre-registered backtest,
and the commands that reproduce every number. Metrics that need post-merge
traffic are measured with `bun run test:health --since-days 7` (merge + 7 days)
and `bun run test:health --since-days 28` (after the fourth scheduled census).

## EVAL_POLICY v2 decision memo (D1)

### Why the census is red

The weekly census is red by arithmetic, not by a handful of broken tests.
Over 22 censuses with trial outcomes the periodic lane recorded 76 failed
trials in 3,550 (about 3.5 failed trials per run) and the gate census 27 in
2,241 (about 1.2 per run). With independent failures, P(green) is e^-3.5 ≈ 3%
for the periodic lane and e^-1.2 ≈ 30% for the gate census; observed green
rates were 0/22 and 8/22. Holding a ~190-case single-trial lane green 80% of
the time needs every case at or below about 0.12% failure per run, which a
live agent judged by one trial does not reach. Fixing the top five chronic
cases leaves the lane red.

Three levers stay inside the no-retry, no-threshold, no-rejudge rule: make
detectors deterministic over structured artifacts (W3), classify INFRA
honestly (W2d, owned by the reliability follow-ups), and make quarantine
reachable for detector, harness and model-latency failures. v2 targets the
third lever.

`test:health` reports the census as three separate numbers, so a policy
change cannot read as a reliability gain: the raw trial failure rate per kind
and failure class, P(lane red) from pooled per-case rates under the recorded
panels, and the same evidence re-aggregated with every case judged on one
trial. Both red probabilities treat every observed failure as
nondeterminism, so they are upper bounds for known-good inputs.

**False-blocking targets.** Periodic lane: at most 1.0 expected failed trial
per census (P(red) ≤ 63%) at the 28-day check; gate census: at most 0.5
(P(red) ≤ 39%). Neither target may be reached by a threshold, retry or
rejudge change. A miss opens a P1 TODOS entry with the per-kind,
per-failure-class breakdown from `test:health`.

### What v2 changes

- **Series identity (W4a, CEO-27, ENG-3).** A case's pass-rate series is keyed
  by the bytes it owns plus `HARNESS_VERSION`: its paid test file, its
  fixtures, and the prompt files of the skills it names (templates, sections,
  manifests and the generated `SKILL.md` the model reads). The series key adds
  the model id, the pinned Claude Code CLI version and the policy version.
  Shared helpers no longer start new series. Every trial also records the
  full consumed-input fingerprint (all touchfiles, globals included) as
  `series_fingerprint`, plus `harness_version`, as provenance.
  (`caseSeriesIdentitiesV2` in `scripts/eval-trial-series.ts`.)
- **Harness guard.** `scripts/harness-version.json` pins the blob of every
  shared execution-harness file: `GLOBAL_TOUCHFILES` plus the session runners,
  the PTY harness, the e2e gate and the LLM judge (36 files). A free test
  (`test/harness-version.test.ts`) fails when one changes without a decision.
  `bun run scripts/bump-harness-version.ts --bump "<reason>"` raises
  `HARNESS_VERSION` and starts a new series for every case;
  `--non-behavioral "<reason>"` records the new blobs as compatible with no
  reset. Entries are one line per file so concurrent PRs that touch different
  files merge cleanly; on a conflict, take the higher version, then rerun.
- **Weekly history (W4b).** Pass-rate history is `evals-periodic.yml` runs on
  `main`: scheduled runs and main dispatches, never a branch dispatch. Branch
  validation runs neither feed pass rates nor count as weeks for quarantine
  expiry and drift.
- **Kinds (W4c).** No kind changes; see the evidence below.
- **Pre-v2 evidence does not qualify.** Readers segment strictly by
  `policy_version`: only v2 trials count toward the quarantine entry rule; v1
  trials stay visible as display-only. Quarantine is not seeded at merge; a
  case enters only after it reaches `entry.minTrials` qualifying v2 trials,
  and `test:health` shows qualifying-vs-required counts with "insufficient
  evidence" distinct from healthy (DX-12).

### W4c: the named "stochastic" cases are deterministic in the record

Recorded census and PR trials (all 95 recorded revisions, October 2026):

| Case | Kind | Passed / trials | Failures |
|---|---|---|---|
| plan-ceo-finding-floor | rule | 26/27 | 1 timeout (608 s) |
| plan-devex-finding-floor | rule | 27/27 | — |
| plan-eng-finding-floor | rule | 9/9 | — |
| plan-design-finding-floor | rule | 9/9 | — |
| plan-ceo-review-plan-mode | rule | 34/34 | — |
| plan-devex-review-plan-mode | rule | 27/27 | — |
| plan-eng-review-plan-mode | rule | 9/9 | — |

The comments calling `plan-*-finding-floor` "stochastic ask-first" are stale:
the record shows these cases behave like rules. AGENTS.md forbids changing a
kind without pass-rate evidence, and a 3-trial panel would triple their cost
for no measurable gain, so they stay `rule`. `plan-design-review-plan-mode`
(17/22) is handled by its detector repair, not by a kind change.

### Backtest (ENG-3, DX-12)

`bun run scripts/eval-trial-series.ts --backtest --weeks 30 --records <dir>`
replays identities with today's registry over historical trees (cases whose
test file did not exist at a revision are absent there).

**Weekly main revisions** (29 Mondays, 06:00 UTC, 2026-03-16 to 2026-09-28).
A case qualifies at a week when one identity holds long enough to collect 10
trials within the last 10 weekly runs (rule and judge cases record one trial
per run, behavior cases a panel of three):

| Identity | Qualifying at the latest week | Mean qualifying share, last 8 weeks | Median identity changes per case |
|---|---|---|---|
| v1 (own touchfiles minus globals) | 0/195 | 0.3% | 15 |
| v2 (case-owned bytes) | 0/195 | 0.7% | 14 |
| v2, reset on every pinned-harness change | 0/195 | 0.1% | 14 |
| v2 without the generated `SKILL.md` (prototype) | 0/217 | 2.0% | 7 |

**Recorded trials** re-keyed by the v2 identity of the revision that produced
them (blocking cases with at least 10 trials on one series):

| Trial source | Recorded (v1) identity | v2 identity |
|---|---|---|
| 22 census runs (5,665 trials) | 52/210 | 67/210 |
| Census + PR lane, 95 revisions (14,898 trials) | 107/210 | 134/210 |

**Harness churn.** The pinned harness changed in 24 of 28 consecutive-week
transitions, and 33 of the last 60 main commits (2026-08-04 to 2026-10-04)
touched a pinned file. About half of PRs therefore record a
`bump-harness-version` decision, and only `--bump` decisions reset series.

### What the backtest shows

1. v2 makes series honest and longer when trials are dense: on the recorded
   census runs, 67 blocking cases reach 10 trials on one series versus 52
   under v1, and 134 versus 107 with PR-lane trials included.
2. Under the approved weekly history (main scheduled runs plus main
   dispatches, about one run per week), no blocking case reaches 10
   qualifying trials at any recent week. A rule case needs ten consecutive
   weekly runs on unchanged owned bytes, and a case's own prompt files
   change about every two weeks (the generated `SKILL.md` carries the shared
   preamble). Excluding the generated `SKILL.md` halves identity churn but
   still qualifies at most 2% of cases, and it would let preamble and resolver
   prompt changes pool unless every such edit went through the harness guard.
3. So v2 alone does not make quarantine reachable. Reaching it needs one of:
   (a) keep the history as approved and accept that quarantine stays rare, so
   census redness is fixed at source (W3) and tracked by `test:health`;
   (b) pool trials from every v2 census run whose series key matches,
   including branch dispatches, while weeks for expiry still count from main
   only — the recorded backtest's 67/210, at the cost of pooling branch code
   whose unbumped harness edits match; or (c) extra census dispatches on an
   unchanged main revision (about $175 recorded each). This PR implements (a)
   as approved; (b) is a one-line change in the trial pool and needs Garry's
   decision before it lands.

### Alternatives considered

- **Gating vs trended.** The native CEO voice proposed keeping live-agent
  cases trended (reported, never blocking) and gating only on deterministic
  detectors. v2 keeps the census blocking because quarantine and the
  pass-rate gate already provide a trended path per case; the
  false-blocking targets above are the check on that choice. If the 28-day
  check misses them, trended reporting for the remaining stochastic cases is
  the next proposal.
- **Adaptive sequential panels** (one trial, escalate to three on a failure,
  about 1.04× cost across ~190 cases) would be the strongest lever for a
  green census. They are not adopted: an escalation triggered by a failure is
  a retry, which Garry's rule forbids.
- **Buy vs build.** Hosted eval platforms (Braintrust, LangSmith, Weights &
  Biases Weave) store per-case pass-rate history and cost natively, but
  gstack's verdicts are produced inside GitHub Actions from Claude Code
  sessions with pre-registered panels and receipts, and the history is a few
  thousand JSONL lines per week that `gh` already serves. A platform would add
  an external dependency and a second source of truth for verdicts without
  removing the in-repo policy. Building on the existing artifacts stays the
  choice; revisit if history outgrows artifact retention (90 days).

### Rollout and rollback (ENG-14, DX-12)

The reader-compatibility commit lands first: readers score only trials under
their own `EVAL_POLICY.version`, show older-policy trials as display-only,
and ignore newer-policy trials with a printed count. The v2 writer (identity
stamping and `version: 2`) lands last. The supported rollback is reverting
the v2 writer commits; a whole-PR revert is not claimed safe.

On a mixed v1/v2 fixture (10 passing v1 trials, 12 v2 trials with 3
failures), the pre-PR reader at 2db0b3a pools the v2 records as the current
v1 series and fails its gate:

```
pass-rates: policy v1, 22 post-policy trial(s), 0 pre-policy (display only)
  FAILING       rule      gate      9/12 [46.8%–91.1%]  ...  plan-ceo-review-plan-mode  (baseline reset)
ACTION REQUIRED (2): [drift] ... [rule-as-behavior] ...
exit=1
```

The compatibility reader ignores the v2 records and keeps the v1 series:

```
pass-rates: policy v1, 10 post-policy trial(s), 0 pre-policy (display only)
  ignored 12 trial(s) recorded under a policy newer than v1: this checkout predates them. Fix: ...
  PASSING       rule      gate      10/10 [72.2%–100%]  ...  plan-ceo-review-plan-mode
exit=0
```
