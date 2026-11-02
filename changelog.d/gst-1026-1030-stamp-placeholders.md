**A declared placeholder restamped to the new version is a stamp, and a carried receipt names the head's version (GST-1026, GST-1030).** gbrain writes a PR's own BEHAVIOR_CHANGES row as `since: 'TBD'` and its `release:restamp` fills in the version. Finish refused that receipt ("behavior, tests or build inputs changed since review"), and the receipt carry and the tree receipt would have refused the same row (gbrain #8444). Separately, a receipt carried after a main merge and a restamp kept the version of the head it was written at (GGST-1).

### Added
- **`stamp_placeholders` policy key** (default `[]`, so nothing changes for a repo that does not set it): literal placeholders such as `["TBD"]`, at most 16, one line and 32 characters each, never `{version}` and never a version. It needs `min_gstack_version` at the release that introduced it.

### Fixed
- **`lib/stamp-only.ts`:** `stampOnlyLine` takes the policy's placeholders. On a line the branch added itself (named by its position), a placeholder inside a `stamp_patterns` template may become that template at the new version, alongside any stamp-form version move on the same line. The built-in forms, a bare `{version}` template, base lines (including one whose text duplicates a branch line) and undeclared placeholders are still refused. Finish's `stampedFiles`, the receipt carry and the tree receipt share it.
- **`bin/gstack-ship-receipt` carry:** the carried receipt's `version` is HEAD's, read the way `write` reads it, instead of the version copied from the old receipt. A head with no version source keeps the version `write --version` recorded.

### Tests
- `test/tree-receipt-stamp-sensitive.test.ts`, `test/gstack-ship-receipt-docs.test.ts`: the shared predicate and the carry classifier accept gbrain's `since: 'TBD'` → `since: '0.60.553.0'` row and refuse an undeclared placeholder, a base row, a duplicated base copy, a built-in form and a line no template matches.
- `test/ship-rereview-triggers.test.ts`: finish routes the declared row as metadata and stops on the same controls.
- `test/restamp-mentions.test.ts`: the tree receipt and the carry accept the declared row and refuse it undeclared or on a base row; the carried receipt records the head's version after a main merge and a restamp; a version-only restamp of an EVIDENCE.md declared in `stamp_files` carries, and an undeclared one stays product.
- `test/gstack-ship-policy.test.ts`: the key's default, floor and validation.

The EVIDENCE.md refusal (GST-1030's second point) reproduces on main and is already fixed by the GST-980 own-row carry this branch builds on, so this change adds only the test for it.
