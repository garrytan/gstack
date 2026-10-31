**pregate `literals` no longer flags a version-history table that the branch extended.** A test that keeps one row per past version of a constant (`[45, "<digest>"]`, then `[46, "<digest>"]`) used to fail `literals` on every bump, because the old row still holds the old value. Truther turned the check down to a warning over it, which also hid real stale tests.

### Fixed
- `lib/pregate/checks/literals.ts`: a row that starts with the old value is skipped when the same table holds a new-value row the branch added (the file at the merge base lacks it). The scan continues to the next line holding the old value, so `expect(PROOF_CHECKS).toBe(45)` below an extended table still fails. A table the branch did not extend, a file that already held a new-value row at the merge base (read through a rename), and a merge base that cannot be read still fail.
- docs/pregate.md describes the history-row rule and the table shapes it recognizes.

### Tests
- `test/pregate-selection.test.ts`: an extended table, a newest-first table and a new file pass; an unextended table, a stale assertion below an extended table, an unextended table beside an extended one, and a table that already held the new row fail at the right line; string-valued and quoted semver histories pass; and an end-to-end `gstack-pregate --only literals` run fails before the table is extended, passes after, and still fails for a renamed file whose table already held the new row.
