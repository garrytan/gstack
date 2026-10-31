# Model panel: four models, each with and without the skill (GST-468)

Supersedes the GSTA-173 preregistration (2026-10-30, commit d209821) for every
panel run after the commit that adds this file. The line GSTA-173 published
stays tied to its own run (2026-10-30-0105, four skill arms, no no-gstack arm).
Frozen before the first run under it; nothing below changes after a result is
seen. Instrument: test/skill-e2e-model-panel.test.ts with
test/helpers/model-panel-harness.ts; free selftest:
test/model-panel-selftest.test.ts.

## Bars
- Pass rate per arm: scored (non-INFRA) cells whose hidden deterministic check passes, with a Wilson 95% interval. Descriptive only: the panel gates nothing and no arm "wins".
- Publication floor: an arm needs PANEL_MIN_COMPLETED = 12 scored cells before any number about it is published; below that its row says INCOMPLETE.
- Skill effect: a model's skill arm and its no-gstack arm differ only when their Wilson intervals do not overlap; otherwise the report says "no measured difference on this panel".
- Ceiling: GSTA-173 passed 58 of 59 scored cells, so this panel is near ceiling. A no-difference result between a skill arm and its no-gstack arm says nothing about whether the skill adds value, and the report must not word it as "gstack adds nothing".
- Suggestion line: the GSTA-173 wording rule for particle-1 (suggestionLine, usefulness floor 0.6) is unchanged and reads the four skill arms only.
- Harness bar: every no-gstack cell records consulted=false (no skill is installed to consult); a true value fails the task's harness assertion.

## Arms
- claude-opus-5-5 Opus 5.5, Anthropic route, build-discipline skill and its CLAUDE.md routing line, reserve $2.00 per cell
- claude-opus-5-5#no-gstack Opus 5.5, Anthropic route, plain CLAUDE.md, no skill, reserve $2.00 per cell
- claude-sonnet-5-5 Sonnet 5.5, Anthropic route, build-discipline skill and routing line, reserve $1.00 per cell
- claude-sonnet-5-5#no-gstack Sonnet 5.5, Anthropic route, plain CLAUDE.md, no skill, reserve $1.00 per cell
- particle-ai/particle-1 particle-1, OpenRouter route with no Anthropic credential, build-discipline skill and routing line, reserve $0.15 per cell
- particle-ai/particle-1#no-gstack particle-1, OpenRouter route with no Anthropic credential, plain CLAUDE.md, no skill, reserve $0.15 per cell
- deepseek/deepseek-v4.1-flash-1017 DeepSeek V4.1 Flash, OpenRouter route with no Anthropic credential, build-discipline skill and routing line, reserve $0.15 per cell
- deepseek/deepseek-v4.1-flash-1017#no-gstack DeepSeek V4.1 Flash, OpenRouter route with no Anthropic credential, plain CLAUDE.md, no skill, reserve $0.15 per cell

## Comparison
stack: loaded
why: the skill arms load the build-discipline skill (extracted from ship/SKILL.md) and a routing line telling the model to invoke it

## No-gstack arm
arms: claude-opus-5-5#no-gstack, claude-sonnet-5-5#no-gstack, particle-ai/particle-1#no-gstack, deepseek/deepseek-v4.1-flash-1017#no-gstack
inputs: the same five fixtures, tickets and hidden checks as the skill arms; the same model, route, credential handling (armEnv by route), tools, turn limit, timeout and spend reservation; every arm runs in Claude Code with max 40 turns, an 8-minute timeout and the tools Bash, Read, Write, Edit, Glob, Grep and Skill, 5 tasks x 3 trials = 15 cells per arm, 120 cells in all
prompt: the ticket text only; the cell's CLAUDE.md is "# Project / Small fixture repo for one ticket." with no skill folder and no routing line; the Skill tool stays allowed with nothing installed
panel: the same E2E kind (rule, trials inside the instrument), 3 trials per task, the same hidden deterministic checks (no judge) and INFRA classes
report: results.md holds one table with a row per arm identity, each `<model>#no-gstack` row beside its skill row, and passes `gstack-eval-plan results --check test/fixtures/model-panel/PREREG.md results.md` before any number is published

## Decoys
- Each hidden check fails on its seed fixture and passes on its reference answer (test/model-panel-selftest.test.ts runs both before any spend).
- model-panel-bugfix carries decoy code paths next to the real bug; a fix in a decoy leaves the check red.
- model-panel-review seeds bugs that pass a quick read; a review that edits source files fails.
- model-panel-changelog lists build, test and tooling commits in COMMITS.md; an entry that includes them fails.
- model-panel-investigate wraps the symptom in a retry; a fix that only retries or edits the tests fails.

## Stop rules
- Spend cap $15 (PANEL_SPEND_CAP_USD) in one ledger (<out>/spend.json). Estimated spend $4-5: GSTA-173 spent $2.09 plus $0.15 at reservation for 60 cells, and this run has 120. A refused reservation stops the panel with STOP: reason=budget_exhausted and keeps every row already written.
- INFRA cells (startup timeout, no result event, MODEL_MIX, 402/429/5xx, error before the first turn) are excluded from pass rates, reported, and never rerun to change a verdict.
- One campaign per run id and PREREG.md sha256; a cell recorded twice in a campaign is refused, and rows from other campaigns are never pooled.
- No rerun after a result is seen.

## Held-out exposure
| set | prior exposure | reservation |
|---|---|---|
| the five model-panel tasks (fixtures, tickets, checks) | GSTA-173 run 2026-10-30-0105: Opus 5.5, Sonnet 5.5, particle-1 and DeepSeek V4.1 Flash, skill loadout only | not held out; this run reads all five for all eight arms |
