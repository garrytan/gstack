{{INHERIT:gpt}}

**GPT-5.5 — new flagship for agentic coding (April 2026).** Released as `gpt-5.5`, NOT `gpt-5.5-codex`. OpenAI collapsed the naming: one model ID sits at the top of ChatGPT and Codex CLI. If you see `gpt-5.5-codex` anywhere, it's a colloquialism — the real model ID has no `-codex` suffix, and `codex -m gpt-5.5-codex` will fail.

**reasoning_effort ladder: `low | medium | high | xhigh`.** Same shape as 5.3-Codex. gstack defaults to `medium` for daily coding. OpenAI's default at launch was not stated in primary docs — if you're benchmarking, query `codex debug models` to confirm.

- `low` — mechanical edits, known-good patterns, fast iteration
- `medium` — daily driver (investigate, review, qa, ship)
- `high` — novel problems, unfamiliar codebases, architectural decisions
- `xhigh` — reserved for long autonomous runs (autoplan, review army, full /cso audit). Measured to burn ~9,000+ reasoning tokens on a single prompt — not for interactive use.

**Migration gotcha from 5.3-Codex.** Codex 0.124.0+ **resets reasoning_effort to the new model's default** when you swap models mid-session. If your muscle memory is `codex -m gpt-5.3-codex -c 'model_reasoning_effort="xhigh"'` for autoplan, switching the `-m` alone is NOT enough — re-pass the `-c` explicitly.

**Why this is worth the price hike (~2x over 5.4).** Two concrete wins:

1. **Long-horizon agentic tasks.** OpenAI's positioning claim: "engineering tasks that typically require human developers up to 20 hours." Terminal-Bench 2.0: 82.7% (vs 5.4 at 75.1%, Opus 4.7 at 69.4%). If a skill chains 6+ steps of autonomous work with tool use (`/autoplan`, `/land-and-deploy`, `/investigate` through to fix), 5.5 is the right call.
2. **Long-context retrieval.** MRCR v2 (512K–1M tokens): 74.0% vs 5.4's 36.6%. For multi-file refactors on large codebases or cross-repo reasoning, 5.5's 1M API context window actually works — 5.4's did not reliably.

Token efficiency claim: OpenAI reports ~40% fewer tokens per task than 5.4, which softens the 2x sticker-price hit. Net cost per completed task is closer to 1.2x than 2x for agentic workloads. For trivial tasks (single-file renames, mechanical format fixes), that efficiency gain doesn't apply — stay on 5.4 or 5.3-Codex-Spark.

**Where Opus 4.7 still edges it out (cross-provider, FYI):**

- SWE-bench Pro: **Opus 64.3% vs 5.5 58.6%** — single-commit repo-local bug fixes
- HLE no-tools: **Opus 46.9% vs 5.5 41.4%** — raw reasoning on hard exam questions
- MCP-Atlas: **Opus 79.1% vs 5.5 75.3%** — multi-tool orchestration as measured there

gstack gates cross-provider escalation by default (we don't tell a Codex user to switch to Claude mid-session). But if you're on 5.5 and the work is clearly "solve this one hard bug in this one file," note that Opus on the Claude side has the edge.

**Where 5.5 reliably regresses vs competitors.**

- **Hallucination rate is high on knowledge benchmarks.** AA-Omniscience reports 86% hallucination. For citation-heavy research or work where "I don't know" must be a valid answer, verify aggressively or prefer the `gpt-5.5-pro` variant (6x price, higher accuracy) — still `UNVERIFIED` for general API availability as of April 2026.
- **Cost discipline.** Community reports: $100/hour burn rate with large database prompts is achievable. If a skill doesn't need 5.5's agentic strength, don't default to it.

**Default tools.** Unchanged from 5.3-Codex: `git`, `rg` (not raw `grep`), `read_file`, `list_dir`, `glob_file_search`, `apply_patch`, `update_plan`. No new first-class tool replaced them.

**update_plan is a first-class tool.** Maintain the plan via the update_plan tool for multi-step tasks. Do not batch-complete — mark each step as you finish it.

**apply_patch over raw writes.** For editing files, prefer `apply_patch` which shows the user a diff. Reserve raw `write_file` for new files.

**New: auto-review is first-class in Codex 0.124.0.** The `auto-review` hook (previously "guardian reviewer") is stable. If you want 5.5 to review its own edit before handing back to the user, wire `auto-review` rather than prompting it inline. This pairs well with gstack's `/review` skill — 5.5 self-reviews fast; `/review` then sweeps the whole branch.

**Completion bias, strong (inherited from 5.3-Codex).** 5.5 will keep going until the task is done. Respect skill-level STOP points (`AskUserQuestion` gates, HARD GATE prose in skill templates) — the skill wins over the model's completion drive.

**Context window split: 1M API, 400K Codex CLI.** The CLI caps at 400K for throughput/cost reasons; the underlying model supports 1M on the Responses API. If you need true 1M-context for a long-horizon plan review, use the Responses API directly rather than Codex CLI.

**Not vs. spark.** No `gpt-5.5-codex-spark` or Cerebras variant shipped. If you need sub-second iteration (what `gpt-5.3-codex-spark` is for), keep using 5.3-codex-spark — it wasn't replaced or deprecated.

**When 5.5 is the right choice:**

- `/autoplan` — chains CEO + eng + design reviews, long-horizon orchestration
- `/investigate` at hypothesis-formation time — the long-context retrieval wins
- `/review` on large diffs (>500 lines) where 5.4's context retrieval wobbles
- `/ship` and `/land-and-deploy` when the project has 6+ mechanical steps
- `/cso --stability` full audit — Nygard pattern detection across the codebase benefits from 1M context
- `/challenge` on substantial plans (>300 lines) — long-context + agentic reasoning

**When NOT to use 5.5 (prefer 5.4 or 5.3-codex-spark):**

- `/browse` commands, single-file renames, `/ship` steps that are pure git/npm invocations — the agentic strength is wasted, cost doubles
- Real-time coding iteration — 5.3-codex-spark still wins at speed
- `/freeze`, `/unfreeze`, `/careful`, `/guard` — pure mechanics, minimal reasoning needed
- Anything OpenAI hasn't published benchmarks for where 5.4 was already passing evals — you won't see the delta, you'll just pay 2x

**Prompting style (from OpenAI's Codex changelog + behavior observation).** No dedicated 5.5 prompting cookbook exists yet (OpenAI published `gpt-5_prompting_guide`, `gpt-5-1_prompting_guide`, `gpt-5-2_prompting_guide`, and a generic `codex_prompting_guide` — no 5.5-specific one as of this overlay). Use the 5.3-Codex guide + these deltas until one ships:

- More token-efficient by default — don't pad prompts with boilerplate the model will strip anyway
- Handles longer planning horizons natively — you can give it a 10-step plan and trust it to manage state via `update_plan`
- Long-context retrieval is genuinely better — stop chunking inputs defensively below 400K
