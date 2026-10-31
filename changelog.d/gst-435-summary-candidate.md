**/ship's lead judgment can now dismiss a reader's own closing summary, on record.** HARN-1 paid for extra review passes because lines like "I found three INFORMATIONAL issues and nothing CRITICAL." collected as CRITICAL findings that `judge` would not let go. Collect still keeps every label, but it now tags a line `summary_candidate` when one of its clauses matches a closed list of closing-summary templates and nothing else on the line could be a finding. The judge may dismiss only a tagged line, quoting it byte for byte with a reason. `verify` re-derives each dismissal from the reader's unchanged output and prints a `DISMISSED:` line for it.

### Known
- **A blocker sentence with no label, file:line or "block" word after a summary is tagged.** "Neither finding is CRITICAL. The token leak must be fixed." can be dismissed, and only the judge's recorded, quoted reason covers it. "The token leak blocks the merge." after the same summary is not tagged.
- HARN-15's "None of the fixes blocks landing; I found four INFORMATIONAL defects and no CRITICAL." is not tagged, because of its "block" word, so it stays a phantom.

### Tests
- `test/review-dispatch.test.ts`: tagged and untagged lines, including the review rounds' lost-blocker shapes; a dismissal that is untagged, paraphrased, unreasoned or folded into is a drop; verify prints the dismissal and turns dirty when the output file changes.

### Docs
- `docs/review-policy.md` (collect, judge, verify) describes the tag, the dismissal rule and the residual risk.
