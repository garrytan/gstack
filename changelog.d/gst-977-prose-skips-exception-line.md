**`gstack-ship-receipt read --check-prose` no longer reads the required Review-loop exception line as counter claims (GST-977).** `write --review-loop-exception` requires the PR body to carry the whole `Review-loop exception: …` line word for word, but the prose check read that line as prose. On gstack-evals #139 the owner's reason "outside 1 and 2 skip detector" was read as a `2 skip` claim against the receipt's 70 skips, so no body could pass both checks.

### Fixed
- **`lib/ship-receipt-prose.ts`:** the line that matches the receipt's own exception exactly (the same test `write` applies) is skipped, like the rendered `## Approvals` block. The same words anywhere else, or a line for a different exception, are still checked.

### Tests
- `test/ship-receipt-prose.test.ts`: the #139 exception text passes `--check-prose` beside a matching `70 skip` claim, and a wrong number elsewhere still fails. On main the same body failed with `gate.unit.skip body=2 receipt=70`.
