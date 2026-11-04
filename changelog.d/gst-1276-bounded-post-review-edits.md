### Fixed

- **A required edit after review binds no longer forces a third review round (GST-1276, GST-1311).** Four instances in two days each cost a Captain grant (#3970, #3985, gstack-evals#203, gbrain#8523 and #8525). Now `gstack-ship-release finish` proves a post-review edit's kind from the diff and sends it to the one scoped reader that test-code edits already take, which isn't a review round (Garry, 2026-11-04). The kinds are: a docs-audit fix to `docs/*.md`, `AGENTS.md` or `CLAUDE.md` whose bytes are the ones the post-audit snapshot recorded; a `.gstack/pregate.json` change that only adds lanes (pregate's own `headPolicyDiff`); and a file matching the new `bookkeeping` ship-policy key. Each needs `--reviewed-base`, at most 20 changed lines, readable text and no gate-scan tag. `ROUTE:` prints `bounded=<n>`. The packet carries the targeted brief for every class, and the reader's clean record must carry the packet's `packet_sha256`. A candidate that fails a proof stays behavior and prints `ROUTE_BOUNDED_REFUSED: <path> <reason> (fix: …)`. Gate-path prose (`review/specialists/targeted.md`, skill templates) never qualifies.
- **The targeted record rebinds from that read.** Finish saves the bound record beside the packet (`SCOPED_RECORD:`). `gstack-ship-receipt write` then carries a money, gate, auth or secret record across the edits (`TARGETED_REBOUND:`), but only when every product or test path changed since the targeted read is in that record, the packet still hashes to it, and the classes since the read compute.
- **A test literal changed after review takes the scoped reader, not behavior (GST-1276, #3984).** This covers a removed line swapped one for one with a line that differs only inside quoted strings and has no assertion or test call, such as a fixture value the secrets scan flagged. A changed expected value or a deleted assertion still stops.
- **`gstack-diff-scope` reads a `.gstack/`-only diff as config** instead of `SCOPE_ERROR=unmatched`, and `.gstack/always-run.json` is now a gate path, so its review depth stays full.

### Added

- **`bookkeeping` ship-policy key**: root-anchored globs of `.tsv`, `.csv` or `.txt` tables, never under `.gstack/` or `.github/`, read from the base only. It needs `min_gstack_version`. See docs/ship-policy.md#bookkeeping.

### Changed

- Finish's scoped-review STOP now says "one scoped reader (not a review round) reads", and its record template includes `packet_sha256`. See docs/review-policy.md#bounded-post-review-edits and docs/troubleshooting.md#route-bounded-refused.
