# A census went red

A periodic census (`evals-periodic.yml`: the weekly periodic lane plus the
gate census) or a marathon run reports each red verdict as one line. This page
takes one red line to a diagnosis, using free commands first. A paid run is
allowed only after a repair.

Where the report is:

- **Main** (the scheduled weekly run, or a dispatch on `main`): a comment on the
  open "Weekly periodic evals: red lane needs triage" issue (marathon: "Weekly
  marathon evals: red lane needs triage").
- **Any branch**: the run's step summary and its `census-report-a<attempt>`
  artifact (marathon: `marathon-report-a<attempt>`). A branch census never
  comments on or closes main's issue.

## Prerequisites

- A checkout of the census branch with `bun install` done. Bun 1.4.2 is the
  tested version.
- `gh` authenticated with read access to the repository's Actions (or
  `GH_TOKEN` set). `eval:pass-rates` downloads artifacts through the REST zip
  route, which also works where `gh run download` is blocked.
- The run id: the number at the end of the run URL in the report's first line.

## 1. Read the red line

A red line in the census report looks like this (one line; a behavior panel
with one failed trial shown):

```
✗ plan-review-prosons-neutral-neg  behavior  FAIL 1/3 (✗✗✓)  t1: assertion (session completed; check failed) — expect(received).not.toMatch(expected)  · cause assertion: session completed; check failed  Expected: not /taste call/i · Received: "a taste call"; t2: assertion  [t1@slice 7, t2@slice 9, t3@slice 9, attempt 1]  evidence: paid-slice-7-a1/shards/skill-e2e-plan-prosons--plan-review-prosons-neutral-neg.t1 (fetch: bun run eval:pass-rates --run 37193478719 --case plan-review-prosons-neutral-neg)  after a repair: bun run scripts/test-paid-shards.ts --tier periodic --case plan-review-prosons-neutral-neg --trials 3
```

| Field | What it says |
|---|---|
| case, kind, verdict | the registry id, its kind (`rule`, `behavior`, `judge`) and the verdict with each trial's outcome; the brackets name the slice and attempt of each trial |
| `failure_class` | the class verdicts read: `assertion`, `contract`, `timeout` or `infra` |
| `cause` | what the machine observed (`failure_cause`, glossary in [TESTING_INTERNALS](../TESTING_INTERNALS.md#failure-causes)), with its evidence line |
| Expected / Received | the failed matcher's values; for a judge, each failing dimension's mean, threshold, sample count and lowest rationale |
| `evidence:` | the slice artifact and shard directory holding the transcript |
| `after a repair:` | the command that runs only this case, once a repair exists |

The cause is a label. Under EVAL_POLICY v1 it never changes a verdict: a
`provider_stall` or `refusal` is still a failed trial. Whether an assertion
failure was a detector, harness or product fault is your diagnosis, not a
machine cause.

## 2. Inspect the evidence (free)

```bash
bun run eval:pass-rates --run <run-id>                 # every red of that census
bun run eval:pass-rates --run <run-id> --case <id>     # one case
```

Expected output: one block per red, with its history and a local evidence path.

```
run 37198445662 (main @ 1a2b3c4d5, 2026-10-04T11:29:00Z): 2 verdict red(s)
✗ qa-only/SKILL.md workflow  periodic/full  FAIL  (history: 7/8 verdicts green)
    t1: assertion / cause assertion: session completed; check failed  clarity 3.67 < 4 (3 samples) "…"
    evidence: ~/.gstack/eval-pass-rates-cache/garrytan-gstack/37198445662/paid-slice-5-a1/shards/skill-llm-eval
```

Only the slices the reds name are downloaded, into
`<state root>/eval-pass-rates-cache/<owner>-<repo>/<run-id>/`. The shard
directory holds the eval record JSON (transcript, judge scores), `junit.xml`
and, for runs after the session ledger landed, `session-ledger.jsonl` (each
session's armed budget, elapsed time, end reason and liveness summary). A slice
artifact over 64 MB is reported as `too large to fetch`; download it from the
run page or with `gh api repos/<owner>/<repo>/actions/artifacts/<id>/zip > slice.zip`.

## 3. Put it in context (free)

```bash
bun run eval:pass-rates --reds --runs 10 --branch <branch>      # reds per census by class and cause, all-green probability
bun run eval:pass-rates --headroom --runs 10 --branch <branch>  # slowest session per case vs its armed budget
bun run eval:pass-rates --case <id> --runs 10                   # the case's pass rate per input series
```

`--reds` ends with the all-green probability: Π(1 − p_i) over the latest
census's cases, with per-case red rates shrunk toward the pooled rate. It is an
approximation (verdicts are not proven independent). A case that is red in
several censuses is a repeat offender; its fix is structural (a replay corpus,
a structured signal or a speedup), not a one-off spelling patch.

What incomplete data means:

| Shown | Meaning |
|---|---|
| headroom `unknown (no session ledger)` | the trials predate the session ledger, or the runner wrote none; the case wall beside it is an upper bound, not a session clock |
| headroom `insufficient` | fewer than 3 session samples; never read as a pass |
| headroom `censored` | a sample timed out, so its real duration is at least the budget |
| cause `unrecorded` | the trial was written before `failure_cause` existed |
| cause `unknown` | the trial failed with no evidence for any other cause |
| `cost unknown` | the harness (PTY, Codex) records no billing; only the known sum is shown |
| `history unavailable (...)` | the GitHub history could not be read; `--gate` fails closed |

## 4. Replay and repair (free)

Diagnose before changing code: product defect, test or detector defect, harness
defect, or infrastructure. Then reproduce with the smallest free check:

```bash
bun test test/detector-corpus-<case>.test.ts      # cases with a replay corpus
bun run eval:pass-rates --reds --dir <evidence dir>   # re-read downloaded artifacts offline
```

The repair lands with a free regression test that fails before it and passes
after it (`AGENTS.md`, "Validation discipline").

## 5. After a repair: one paid run

Run the line's `after a repair:` command, which selects only that case:

```bash
bun run scripts/test-paid-shards.ts --tier periodic --case <id>              # a rule case: one diagnostic trial
bun run scripts/test-paid-shards.ts --tier periodic --case <id> --trials 3   # a behavior case: its 3-trial panel
```

A judge prints an `EVALS_JUDGE_SELECTION_JSON=... bun test <file> -t '<pattern>'`
command instead; a changed judge gets one 3-sample panel.

Rules (see [TESTING_INTERNALS](../TESTING_INTERNALS.md#eval-verdict-policy)):

- A paid run follows a concrete repair. A red census is never rerun on
  unchanged inputs.
- A diagnostic run never forms a verdict. The next census on the repaired head
  decides.
- A census whose every red is machine-classified INFRA or INCOMPLETE is
  re-dispatched once automatically; both runs stay reported.
- An unresolved red is listed as a named red with its diagnosis. A case enters
  `CASE_QUARANTINE` only under its entry rule, and a product defect is never
  quarantined.
