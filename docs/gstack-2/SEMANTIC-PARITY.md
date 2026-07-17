# Semantic parity evidence

GStack 2 semantic parity uses the recorded 1.x base
`bb57306d98c97011b0919c6132705a15b1579781` as its primary oracle. It does not
ask a model to decide whether a rewrite is “close enough.” Each representative
fixture selects a specialist through structured product/evidence signals, then
compares the pinned host-rendered 1.x workflow with the legacy body loaded by
the GStack 2 dispatcher.

Run:

```bash
bun run scripts/gstack2/semantic-parity.ts
bun test test/gstack2-semantic-parity.test.ts
```

The first command writes reproducible evidence under
`evals/parity/transcripts/`:

- 14 constitution-required suites and 15 executions (DX and specification are
  separate executions);
- all 15 requested comparison dimensions per execution;
- exact workflow and semantic-signature hashes;
- all 16 carved-section comparisons;
- authority-policy unit cases for evidence, trust boundaries, physical-device
  substitution, mutation authority, and structured routing;
- every linked bug-fix difference classified as `INTENTIONAL_IMPROVEMENT` with
  its upstream PR and regression fixture.

The current deterministic manifest is green: **295 checks across 14 suites,
15 executions, 15 dimensions, 16 carved sections, and nine authority-policy
unit cases**. Its base is
`bb57306d98c97011b0919c6132705a15b1579781` and it explicitly records that a
live model is not required for the primary verdict.

Exact preserved bodies are stronger evidence than an LLM similarity score:
questions, order, pressure, smart skips, rubrics, gates, evidence, artifacts,
mutation, exits, recommendations, and voice cannot disappear while normalized
full-body equality holds. The structured route and authority-policy units cover
deterministic controls that exist outside those bodies. They start from a
hand-authored semantic operation envelope, so they are policy-unit evidence,
not proof that a live host correctly decodes a hostile natural-language
request. This is deterministic policy evidence, not behavioral-adversarial
proof.

The installed-host lane currently has no passing live run. V1 **failed**. The
immutable v2 run also **failed**: QA passed, while debug, review, and ship were
false negatives caused by the v2 read-only-Git warning classifier. Its artifact
is
[`2026-07-17T04-09-01-809Z-3d23a270.json`](../../evals/host-adversarial/runs/2026-07-17T04-09-01-809Z-3d23a270.json),
SHA-256
`7ab15ea575cb9a634b7d00212dd9d74902b1188281ae6a503a32ccf382facbf5`.
The v3 offline harness is green at 18 pass / 0 fail and 111 assertions, but live
v3 has not run and has no artifact. The P0 gate therefore remains open. See the
[installed-host evidence overview](../../evals/host-adversarial/README.md).

## Optional live-model supplement

A paid, non-deterministic comparison is opt-in and is never the primary gate:

```bash
GSTACK2_LIVE_SEMANTIC=1 bun run scripts/gstack2/semantic-parity.ts \
  --live --model=<exact-model-id> --limit=15 --max-budget-usd=0.25 --resume-live
```

The live runner uses Claude CLI bare mode with session persistence, slash
commands, browser integration, and tools all disabled. It requests one turn
per actor and judge and passes a USD 0.25 per-call budget by default
(configurable up to USD 1.00), rejects credential-shaped prompts, records the
exact prompts and model, redacts credential-shaped output, and writes
structured baseline/candidate responses plus a 15-dimension judge result under
`evals/parity/transcripts/live/<exact-model-id>/`. The CLI budget is not a hard
preauthorization ceiling: one observed provider call reported USD 0.81 after a
USD 0.25 limit was supplied. Treat the setting as a guardrail, stop on an
overage, and never loop until a favorable verdict. A model is not allowed to
overrule a deterministic regression or unexplained loss, and human review
remains authoritative for disputed results.

`--resume-live` reuses only a non-regression transcript produced by the exact
same model, per-call budget, and baseline/candidate/judge prompt hashes. It
never reuses evidence across model, budget, or prompt changes.

### Current live evidence

The retained Claude Haiku evidence is **not green**:

- `live/attempts/office-hours-haiku-v1-regression.json` records a regression
  from the earlier visible generated-wrapper prompt;
- `live/claude-haiku-4-5-20251001/ceo-review.json` also predates the current
  invisible thin wrapper and is prompt-stale; and
- `live/claude-haiku-4-5-20251001/office-hours.json` is a post-wrapper sample
  classified `REGRESSION`, in part because the independently sampled baseline
  response included details that its own sample omitted elsewhere even though
  the candidate's source body is byte-preserved.

These files expose two separate facts: visible wrapper prose can bias an actor,
and independent first-turn summaries can create apparent losses even when the
underlying source is identical. The wrapper was reduced to an invisible,
five-line-or-smaller provenance prelude and that invariant is now structural.
The remaining sampling variance is why live evaluation stays supplemental.
None of the three transcripts is release-pass evidence, and an obsolete prompt
must not be silently reused or overwritten.

`bun run gen:gstack2` refreshes the deterministic contracts, scenarios,
regressions, and manifest while preserving `evals/parity/transcripts/live/`.
Run deterministic semantic parity after the generator when preparing final
release evidence; do not let regeneration erase unfavorable live history.
