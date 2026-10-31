# particle-1 on gstack's model panel (October 2026)

Measured October 30, 2026 at commit d209821, which preregistered the panel before any paid run. Run id `2026-10-30-0105`. Data: [rows.jsonl](particle-1-2026-10/rows.jsonl) (one row per cell) and [summary.json](particle-1-2026-10/summary.json).

## Result

| Model | Passed | 95% interval | INFRA cells | Cost per task |
|---|---|---|---|---|
| Opus 5.5 (`claude-opus-5-5`) | 15/15 | 80–100% | 0 | $0.088 |
| Sonnet 5.5 (`claude-sonnet-5-5`) | 15/15 | 80–100% | 0 | $0.037 |
| particle-1 (`particle-ai/particle-1`) | 15/15 | 80–100% | 0 | $0.007 |
| DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash-1017`) | 13/14 | 69–99% | 1 | $0.008 |

The preregistered wording rule (`suggestionLine` in [test/helpers/model-panel-harness.ts](../../test/helpers/model-panel-harness.ts)) produced this line:

> particle-1 passed 15/15 tasks on gstack's model panel (Sonnet 5.5 15/15, Opus 5.5 15/15, DeepSeek V4.1 Flash 13/14) at $0.007 per task vs $0.037 for Sonnet 5.5, the cheapest of the four models measured (no measured difference from Sonnet 5.5 on this panel; measured 2026-10-30 in Claude Code via OpenRouter). Worth trying for low-stakes steps; keep blocking reviewers on your main model.

## How to read it

- **The panel is easy.** 58 of the 59 scored cells passed, across all four models. So the panel shows that particle-1 can do small gstack-shaped tasks at about one-fifth of Sonnet 5.5's cost per task. It can't tell the models apart on these tasks, so it says nothing about harder work. "No measured difference" means exactly that, not "as good as Sonnet".
- **Cost is measured, not listed.** Each cell is priced from its own token counts (uncached input, cache reads, cache writes, output) at the rates in `lib/pricing.ts`, not from Claude Code's `total_cost_usd`, which prices gateway models at Anthropic rates. particle-1 and DeepSeek ran at OpenRouter's standard (peak) rates. Particle's own API is 50% cheaper from 8:30 pm to 4 am Eastern.
- **Same harness for every model.** Every arm ran in Claude Code `2.1.312` with the same tools, turn cap (40), timeout (8 minutes), the extracted gstack build-discipline skill and a hidden check. Claude Code's default effort settings were used for every arm, and particle-1 used its default reasoning effort (high). Particle trained particle-1 in a different agent harness (Terminus 2), so this setup may understate it.
- **No model mixing.** Every gateway cell billed only its own model. The harness pins every Claude Code model alias to the arm's model and would classify any other billed model as INFRA (MODEL_MIX). No gateway cell had an Anthropic credential in its environment.

## The panel

Five tasks, each scored by a hidden check that the selftest proves fails on the seed fixture and passes on a reference answer ([test/model-panel-selftest.test.ts](../../test/model-panel-selftest.test.ts)):

1. **bugfix:** fix a price-formatting bug without touching the tests (`arm-benchmark/bugfix-decoys`).
2. **crud:** add `DELETE /notes/:id` with 204/404 and a test (`arm-benchmark/crud-endpoint`).
3. **review:** pre-landing review of a new file with a planted SQL injection and a page-offset bug. REVIEW.md must name both, and the source must stay unchanged.
4. **changelog:** write the 1.4.0 entry from a commit list, user-facing changes only.
5. **investigate:** find the root cause of a timezone date bug, leaving the tests and a retry decoy untouched. The fix must also hold in a UTC+14 zone.

Four models × five tasks × three trials = 60 cells, at most four at a time, under a $15 spend ledger. The run spent $2.09, plus $0.15 still counted at its reservation for the one cell with no usage.

## Non-passing cells

- **DeepSeek, review, trial 1: INFRA.** The cell hit the 8-minute timeout. The CLI was killed before it wrote a result event, and `classifyCell` counts a missing result event as INFRA. That conflicts with the function's own comment, which says a timeout after work is scored by the check. The run kept the verdict as computed, because preregistered rules don't change after a result is seen. The fix (score a timed-out cell's working tree) is left for the next run. It affects only the DeepSeek count.
- **DeepSeek, investigate, trial 2: fail.** It fixed the date bug, then deleted the retry decoy the ticket said to leave alone.

## Every cell

| Task | Arm | Trial | Verdict | Turns | Cost (USD) | Note |
|---|---|---|---|---|---|---|
| bugfix | opus | 1 | pass | 6 | 0.0724 |  |
| bugfix | opus | 2 | pass | 5 | 0.0673 |  |
| bugfix | opus | 3 | pass | 6 | 0.0726 |  |
| bugfix | sonnet | 1 | pass | 7 | 0.0346 |  |
| bugfix | sonnet | 2 | pass | 7 | 0.0336 |  |
| bugfix | sonnet | 3 | pass | 7 | 0.0335 |  |
| bugfix | particle | 1 | pass | 7 | 0.0058 |  |
| bugfix | particle | 2 | pass | 7 | 0.0063 |  |
| bugfix | particle | 3 | pass | 10 | 0.0080 |  |
| bugfix | deepseek | 1 | pass | 9 | 0.0055 |  |
| bugfix | deepseek | 2 | pass | 12 | 0.0036 |  |
| bugfix | deepseek | 3 | pass | 7 | 0.0035 |  |
| changelog | opus | 1 | pass | 5 | 0.0649 |  |
| changelog | opus | 2 | pass | 5 | 0.0638 |  |
| changelog | opus | 3 | pass | 5 | 0.0644 |  |
| changelog | sonnet | 1 | pass | 6 | 0.0294 |  |
| changelog | sonnet | 2 | pass | 6 | 0.0312 |  |
| changelog | sonnet | 3 | pass | 6 | 0.0314 |  |
| changelog | particle | 1 | pass | 6 | 0.0035 |  |
| changelog | particle | 2 | pass | 6 | 0.0034 |  |
| changelog | particle | 3 | pass | 7 | 0.0034 |  |
| changelog | deepseek | 1 | pass | 7 | 0.0052 |  |
| changelog | deepseek | 2 | pass | 6 | 0.0081 |  |
| changelog | deepseek | 3 | pass | 6 | 0.0076 |  |
| crud | opus | 1 | pass | 6 | 0.0905 |  |
| crud | opus | 2 | pass | 6 | 0.0899 |  |
| crud | opus | 3 | pass | 5 | 0.0832 |  |
| crud | sonnet | 1 | pass | 9 | 0.0401 |  |
| crud | sonnet | 2 | pass | 9 | 0.0408 |  |
| crud | sonnet | 3 | pass | 9 | 0.0411 |  |
| crud | particle | 1 | pass | 10 | 0.0110 |  |
| crud | particle | 2 | pass | 11 | 0.0071 |  |
| crud | particle | 3 | pass | 9 | 0.0077 |  |
| crud | deepseek | 1 | pass | 9 | 0.0061 |  |
| crud | deepseek | 2 | pass | 7 | 0.0061 |  |
| crud | deepseek | 3 | pass | 9 | 0.0046 |  |
| investigate | opus | 1 | pass | 8 | 0.1070 |  |
| investigate | opus | 2 | pass | 6 | 0.0949 |  |
| investigate | opus | 3 | pass | 6 | 0.0933 |  |
| investigate | sonnet | 1 | pass | 6 | 0.0358 |  |
| investigate | sonnet | 2 | pass | 6 | 0.0359 |  |
| investigate | sonnet | 3 | pass | 6 | 0.0352 |  |
| investigate | particle | 1 | pass | 8 | 0.0062 |  |
| investigate | particle | 2 | pass | 8 | 0.0064 |  |
| investigate | particle | 3 | pass | 8 | 0.0100 |  |
| investigate | deepseek | 1 | pass | 10 | 0.0070 |  |
| investigate | deepseek | 2 | fail | 12 | 0.0124 | FAIL: the retry decoy must not change |
| investigate | deepseek | 3 | pass | 16 | 0.0056 |  |
| review | opus | 1 | pass | 6 | 0.1140 |  |
| review | opus | 2 | pass | 6 | 0.1214 |  |
| review | opus | 3 | pass | 6 | 0.1136 |  |
| review | sonnet | 1 | pass | 6 | 0.0466 |  |
| review | sonnet | 2 | pass | 6 | 0.0448 |  |
| review | sonnet | 3 | pass | 6 | 0.0454 |  |
| review | particle | 1 | pass | 9 | 0.0060 |  |
| review | particle | 2 | pass | 11 | 0.0117 |  |
| review | particle | 3 | pass | 10 | 0.0081 |  |
| review | deepseek | 1 | infra | - | unknown | no result event (timeout) |
| review | deepseek | 2 | pass | 18 | 0.0163 |  |
| review | deepseek | 3 | pass | 13 | 0.0177 |  |
