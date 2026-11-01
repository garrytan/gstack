# GST-766 part (b) no-loss replay: result

Preregistration: PREREG.md (commit 6e05c592f, before any collector edit). Inputs: manifest.json (30 entries, 49 candidates, frozen 6e6685f6 baseline), verdicts-sol.jsonl and verdicts-argon.jsonl (blind judges, 67 items).

## Verdict: FAIL. The change is not shipped.

Replay of the candidate collector (settle step: a native FIXABLE finding with its own `Blocks: no` and no `Blocks: yes` collects at its stated severity) against the frozen baseline:

```
REPLAY: entries=30 gold_blockers=19 affected=38 lowered=38 lowered_gold_nonblocking=30 lost=8 negated_cases=99 negated_lost=0 controls_lowered=4/4 confinement=ok
```

The bar was lost=0. 8 of the 38 lowered findings were adjudicated blocking (preregistered rule: blocking if either judge says so). Under the stricter both-judges reading, which was not the preregistered rule and is shown only as a sensitivity check, 1 is still lost: cap36-adversarial-native-1#2, "the backstop nonce is refused" (scripts/gate.ts:214 in gstack-evals #36). The reviewer wrote `Severity: Medium. Blocks: no` on it. Both judges called it blocking, and both no-gstack reviewers reported the same bug.

Mechanics worked: all 4 positive controls lowered, confinement held (no other label or finding changed), and all 99 of #3803's negated-line cases collect unchanged. Five findings whose `Blocks: no` carries an explanation ("Blocks: no, because …") stayed CRITICAL, because the preregistered predicate needs a closing clause.

## Fresh #36 capture and the no-gstack arm

| Entry | Findings | CRITICAL at baseline / with change | Gold blocking (either judge) | Gold blocking (both judges) |
|---|---|---|---|---|
| gstack native run 1 | 5 | 4 / 0 | 1 | 1 |
| gstack native run 2 | 5 | 3 / 0 | 1 | 0 |
| gstack native run 3 | 5 | 3 / 0 | 3 | 0 |
| gstack native run 4 | 6 | 2 / 0 | 1 | 0 |
| gstack outside voice | 3 | 3 / 3 | 3 | 0 |
| no-gstack Opus 5.5 | 4 | 0 / 0 | 3 | 1 |
| no-gstack GPT-6.1 Sol | 2 | 0 / 0 | 2 | 1 |

Both collectors give the no-gstack outputs identical labels, as preregistered: a plain prompt writes no FIXABLE. The one finding both judges called blocking (the refused backstop nonce) was found by both plain reviewers and by 1 of the 4 gstack native runs, and that run marked it `Blocks: no`.

## Why null (R48)

- Exposure: 38 findings lowered across 30 saved and fresh outputs, all 4 controls among them. The change was exercised well past the 10-finding floor.
- Task fit: the question was whether the native voice's own `Blocks: no` can be trusted. It can't: 8 of 38 (either judge), 1 of 38 (both judges) of the findings it would lower are blockers.
- Power and saturation: n=38 lowered. The judges disagree often (51 of 67 agree; Sol called 19 blocking, Gemini 3), so the gold is noisy, but even the strictest reading has a loss.
- Without the part under test: the FIXABLE-to-CRITICAL rule is what keeps the backstop bug blocking today. Plain frontier reviewers found that bug without gstack, but gstack's native voice under-rated it.

Verdict: CUT-CANDIDATE. Letting the native voice's `Blocks: no` lower a FIXABLE finding shouldn't exist: on this evidence it loses real blockers. KEEP the one-way rule as it is.
