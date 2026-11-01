**Eval planning prices Claude Haiku 5.5, GPT-6 Luna and Gemini 4 Argon, and the Codex docs name the current OpenAI tiers (#3640, #2943).** Before, `gstack-eval-plan arms --arms claude-haiku-5-5` stopped with EVAL_PRICE_MISSING because `lib/pricing.ts` had no row for it. docs/hosts.md and the /codex example still named gpt-5.6-sol as the current Sol model.

### Added
- **Price rows** for `claude-haiku-5-5` ($0.10 / $0.50, cached $0.01, standard tier up to 100,000 tokens), `gpt-6-luna` ($0.10 / $0.50, cached $0.01) and `gemini-4-argon` ($4.00 / $20.00, cached $0.20). Each row cites its provider page. Argon uses the rates that start on 2026-12-01, so estimates never come in low after that date. A repository's model-policy document that names one of these models now gets it as an eval arm.

### Changed
- **docs/hosts.md and /codex** name `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna` as the current tiers. They also say the bounded-scope overlay still applies only to `gpt-5.6-sol` until it has its own eval.

Thanks to @exGeni (#3640) and @DanCanadian (#2943) for the reports. The TypeSafe Jev rows from #3640 are not included, because a $0 output price breaks the price table's rule that every row has an output price.
