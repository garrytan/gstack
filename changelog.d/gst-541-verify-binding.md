**`gstack-review-dispatch verify` now catches a merged findings file edited after collect.** Verify used to compare only output hashes and line counts. So a `merged.jsonl` row whose label was lowered, or whose text was replaced with another line's summary, passed with `VERIFY: clean` once the judge agreed with the edited row. Verify now re-parses each reader's unchanged output and checks every merged row against the finding at its index, label and raw text byte for byte. A mismatch prints `merged_line_differs` on the OUTPUT and JUDGE rows, and verify is dirty. A missing output file (even for a reply with no findings), a judgment run on a copy of the merged file, and merged rows that collect never wrote are dirty too.

### Known
- Deleting a whole output event together with its merged rows still verifies clean, because the ledger keeps no anchor for it. It is listed for the structured-findings plan.

### Tests
- `test/review-dispatch.test.ts`: a forged label, a summary copied onto a blocker's id, a deleted output file, a judgment on a forged copy and an extra merged row all verify dirty. Each verified clean at main c830c9b.

### Docs
- `docs/review-policy.md` (verify) describes the per-row check.
