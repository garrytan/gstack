**`gstack-review-dispatch verify` now catches a merged findings file edited after collect.** Verify used to compare only output hashes and line counts. So a `merged.jsonl` row whose label was lowered, or whose text was replaced with another line's summary, passed with `VERIFY: clean` once the judge agreed with the edited row. Verify now re-parses each reader's unchanged output and checks every merged row against the finding at its index, label and raw text byte for byte. A mismatch prints `merged_line_differs` on the OUTPUT and JUDGE rows, and verify is dirty.

### Tests
- `test/review-dispatch.test.ts`: a forged label and a summary copied onto a blocker's id both verify dirty. Both verified clean at main c830c9b.

### Docs
- `docs/review-policy.md` (verify) describes the per-row check.
