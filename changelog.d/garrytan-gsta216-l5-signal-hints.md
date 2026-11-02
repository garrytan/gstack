**/plan-tune now learns from answers to questions that aren't in its registry, when the skill says which preference the question is about (#3442).** Before, an answer to an ad-hoc question id such as `plan-ceo-review-add-caching` moved no dimension, because only registered ids carry a signal. Most logged answers are on ad-hoc ids, so inferred values stayed near 0.5.

### Added
- **Signal hints at ask time:** a skill can write `<gstack-qid:{id};signal={key}>` in the question and `"signal_key":"<key>"` in the `gstack-question-log` row, choosing the key from the fixed list that `gstack-question-preference --signal-keys` prints. `--derive` uses the hint only when the id has no registry entry, the key is a known signal, and the answer matches one of that signal's options, by the exact key or the key's own words. Hinted answers fall under the same per-day cap as registered ones.
- **`hinted_events`** in the profile, and `(hinted)` on `--trace` rows, so you can see which answers came from hints.

### Changed
- One shared marker parser (`scripts/qid-marker.ts`) now serves the log hook, the preference hook and the Codex session import. A hint never changes auto-decide or one-way-door handling. An unknown hint, or a hint on a registered id, is dropped with `QLOG_SIGNAL_KEY_DROPPED`, and the row is still logged.

### Tests
- New tests that fail on main check that derive moves a dimension for a hinted ad-hoc answer and not for an unhinted one. Unknown keys, choices outside the signal, and registered ids ignore the hint. Hinted answers share the per-day cap. The hooks and the Codex import carry the hint into the log.
