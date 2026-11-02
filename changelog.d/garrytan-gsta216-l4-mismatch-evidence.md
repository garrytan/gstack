**/plan-tune no longer reports a mismatch between your stated and observed preferences when it has no observed answers behind it (#3436).** `--check-mismatch` compared a declared value against an inferred value that had never moved from its 0.5 starting point, so a strong declaration with no matching answers printed `scope_appetite: declared 0.9 vs inferred 0.5 (gap 0.4)` even though no logged answer touched that dimension.

### Fixed
- **`bin/gstack-developer-profile`**: `--check-mismatch`, `--gap` and the gap that `--derive` stores compare a dimension only when at least 3 logged answers moved it. `--check-mismatch` still needs 10 logged answers overall before it reports anything. Below the 3-answer floor, `--check-mismatch` prints `no observed evidence` or `too little evidence (n of 3 events)` instead of a gap, and `--gap` lists the dimension under a new `low_evidence` field. A profile derived before `contributing_events` existed keeps the old behavior until its next derive.
- **/plan-tune "Show gap"**: says "not enough observed answers yet" for those dimensions instead of calling them drift.

### Tests
- `test/gstack-developer-profile.test.ts`: a declared dimension with no evidence is not flagged by `--check-mismatch` or `--gap` (both failed on main), 1 or 2 events report too little evidence, 3 events are compared, three same-day answers that agree with the declaration still report not enough data, and `--derive` stores no gap without evidence.
