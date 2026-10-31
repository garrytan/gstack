**gstack now knows particle-1 and has measured it on its own tasks.** particle-1 (Particle AI, October 28, 2026) passed 15/15 cells on a preregistered five-task panel, the same as Sonnet 5.5 and Opus 5.5, at $0.007 per task against Sonnet 5.5's $0.037 (run `2026-10-30-0105`, Claude Code through OpenRouter). The panel is easy, so it shows no measured difference between the models, not that they are equal. Results and every cell are in [docs/evals/particle-1-2026-10.md](docs/evals/particle-1-2026-10.md).

### Added
- **particle-1 and DeepSeek V4.1 Flash in the price table.** `lib/pricing.ts` prices `particle-1` ($0.25 input, $0.03 cached, $1.00 output per million tokens) and `deepseek-v4.1-flash-1017`; provider-prefixed ids such as `particle-ai/particle-1` resolve to them.
- **`gstack-model-benchmark --models particle,deepseek`** runs those models in Claude Code through OpenRouter (`OPENROUTER_API_KEY`). The child process gets no Anthropic credential, every Claude Code model alias is pinned to the arm's model, and a run that billed any other model is an error. `/benchmark-models` lists both and says what they send to OpenRouter.
- **A preregistered model panel** (`test/skill-e2e-model-panel.test.ts`): five gstack-shaped tasks, four models, three trials, each cell scored by a hidden check and priced from its own tokens. It runs on demand, not in the weekly eval run, because CI has no OpenRouter key.

### Changed
- **particle-1 counts as the DeepSeek family** for outside-voice independence, because Particle built it on DeepSeek V4.1 Flash. A particle-1 voice is never treated as independent of a DeepSeek one.
- **One provider registry** feeds the benchmark CLI, its dry run and the runner.

### Fixed
- **`--models` with no valid provider now exits 1** instead of quietly running claude.
