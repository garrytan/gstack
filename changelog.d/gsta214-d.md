**Codex outside reviews report their token usage (#2948).** Codex already emits token counts in its `--json` events, and gstack used to throw them away. When `lib/outside-review-result.ts` is given an events file, it now prints `OUTSIDE_USAGE: input=… cached_input=… output=… reasoning_output=…` (only the counters Codex reported), or `OUTSIDE_USAGE: unknown`, on every verdict.

### Changed
- **Every Codex outside voice that runs `codex exec --json`** (/review, /ship, /autoplan, the plan reviews) now prints one more stdout line, `OUTSIDE_USAGE:`, after `VERDICT:` and `FINDINGS:`.
- **One usage parser** (`usageFromEvents`, now in `lib/outside-review-result.ts` and re-exported by `lib/outside-voice-runner.ts`). A cumulative `total_token_usage` snapshot wins; without one, the latest `turn.completed` usage does, because Codex reports the session's running total there. It adds cached, cache-write, reasoning and total counters when the events carry them.

Thanks to @omicron-soft for the report. Storing usage in review-log rows, the native `codex review` path and a token column in /ship come in a follow-up.
