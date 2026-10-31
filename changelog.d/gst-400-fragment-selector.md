**A PR's changelog.d fragment no longer brings back every paid gate case.** Since fragments became the way every PR records its CHANGELOG entry (v1.91.342.0), the PR eval selector read each `changelog.d/<slug>.md` as an unknown dependency and restored the full gate, so it saved nothing on any PR (GST-400, found on #3668).

### Fixed
- **`scripts/test-pr-profile.ts`** treats every file under the ship policy's `changelog_fragments.dir` as having no eval dependents. A touchfile that names a fragment still selects its case.

### Tests
- `test/test-pr-profile.test.ts` covers a fragment-only PR (no full fallback, no cases) and a touchfile that names a fragment.
