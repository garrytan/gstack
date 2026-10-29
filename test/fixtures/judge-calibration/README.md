# W2 judge calibration corpus

Preregistered corpora for the W2 judge schema migration (comparison 1: JSON schema
transport, prompt prose unchanged). One directory per distinct request
configuration, keyed by prompt builder, model, max_tokens, stream, effort and
thresholds rather than by test case.

Each `<config>/corpus.json` holds 24 items: 8 clearly passing, 8 clearly failing and
8 threshold-adjacent, with ids `p01-p08`, `f01-f08` and `a01-a08`. The held-out third
(`p06-p08`, `f06-f08`, `a07`, `a08`) is dispatched only after every development item
has been sampled, with the same frozen requests. `expected` is the verdict a careful
grader would reach under the eval's pass rule (`pass_rule`). The author labeled every
item; a separate agent run then labeled every item blind (shuffled ids, no author
labels) before any schema was written (for `cookie-workflow`, before any request with the
schema was sent). `second_review` records that verdict, and each
disagreement carries `author_expected` and the third reviewer's `adjudication`.

`scripts/judge-calibration.ts` runs the comparison and `scripts/judge-calibration-configs.ts`
defines each configuration. Run outputs land in `<config>/runs/`:
`comparison-1.samples.jsonl` holds every sample with its value or error kind, latency
and priced usage, and `comparison-1.result.json` holds the flip rates, agreement,
false passes, error rates, p95 latency, landing decision and the UC3 prose-step
trigger. `manifest.json` prices every planned call before dispatch.

## Comparison (1) results (2026-10-03, `claude-fable-5-1`, unless the row says otherwise)

Flips are panel-verdict differences on items where both panels completed: old-vs-old
is `old-a` vs `old-b`, new-vs-old is `new` vs `old-a`. Agreement is items whose panel
verdict matches `expected`. A configuration lands when new flips are at most old flips
plus one, agreement does not drop, there are zero new false passes and the new p95 is at
most 80% of `JUDGE_MS` (96 s).

| Config | Old-vs-old flips | New-vs-old flips | Agreement old / new | New false passes | Errored samples old / new | p95 s old / new | Held-out new flips, agreement | Cost | Decision |
|---|---|---|---|---|---|---|---|---|---|
| `arm` | 0/24 | 0/24 | 24 / 24 | 0 | 0 / 0 | 7.6 / 5.9 | 0/8, 8/8 | $6.16 | lands |
| `qa-workflow` | 2/24 | 4/24 | 17 / 17 | 1 (a06) | 0 / 0 | 26.7 / 27.6 | 1/8, 6/8 | $18.94 | held: new flips above old + 1, one new false pass |
| `qa-health-rubric` | 0/24 | 1/24 | 22 / 23 | 0 | 0 / 0 | 17.0 / 18.7 | 0/8, 8/8 | $10.62 | lands |
| `qa-anti-refusal` | 0/24 | 0/24 | 23 / 23 | 0 | 0 / 0 | 12.5 / 13.4 | 0/8, 8/8 | $7.02 | lands |
| `cross-skill` | 0/24 | 0/24 | 23 / 23 | 0 | 0 / 0 | 19.7 / 22.6 | 0/8, 8/8 | $19.86 | lands |
| `voice` | 0/24 | 0/24 | 22 / 22 | 0 | 0 / 0 | 13.3 / 13.7 | 0/8, 8/8 | $8.09 | lands |
| `workflow-default` | 2/23 | 3/23 | 21 / 21 | 0 | 1 / 1 (refusal, f03) | 29.5 / 25.8 | 0/8, 8/8 | $19.66 | lands; UC3 prose step triggered by the errored sample |
| `cookie-workflow` (2026-10-25, `claude-sonnet-5-5`) | 1/22 | 1/23 | 22 / 23 | 1 (a07) | 2 / 0 (parse, a05 and a07) | 13.6 / 9.6 | 1/7, 7/8 | $2.81 | held: one new false pass |

Among the 2026-10-03 configurations, no sample errored under either prompt except one refusal each on `workflow-default` item
`f03` (a stubbed cookie-import workflow): the old prompt refused once in `old-b` and the new
prompt once, so that item's panels are incomplete and it is excluded from the flip counts
(23 compared). The refusal is content-driven rather than format-driven, but under the eng
trigger any errored new sample calls for a calibrated prose step, which is deferred to
TODOS. `workflow-default` was funded after the first pass with a $25 extension of the W2
reservation; its 14 cases now send `WORKFLOW_JUDGE_RESPONSE_SCHEMA` without the
compact-reasoning validator (still only on `ship`). The frontier (`review`) configuration has no corpus and stays on today's request. A $0.12 two-call pilot sized
output tokens before the manifest was priced. Total W2 spend: $90.47 of $115.

`cookie-workflow` (GSTA-91, separately funded) was held, and the hold was released on
GStack Minder's ruling of 2026-10-29: "GStack Minder, 2026-10-29: release the GSTA-91 hold; a07 is
matched by old-b; free-text parse errors cost train 42" (`cookie-workflow/release.json`). The
cookie workflow judge now sends `WORKFLOW_JUDGE_RESPONSE_SCHEMA`, with its thresholds, model and
samples unchanged; the comparison below stays recorded as held. Its one
new false pass, a07, scored 4/4/4 on all three new samples and on all three `old-b` samples;
`old-a`'s a07 panel is incomplete because one old sample returned invalid JSON (the defect the
schema transport removes), so the comparison counts it against the new request only. Both
valid `old-a` a07 samples also scored 4/4/4. The old
request failed to parse 2 of 144 samples; the new one 0 of 72. The failed landing condition
triggers the UC3 prose step, which is deferred to TODOS. Its `manifest.json` entry was priced
separately (`priced_at`, `funding`) and is maintained by hand: the `manifest` command rewrites
the whole file, so keep that entry when regenerating.
