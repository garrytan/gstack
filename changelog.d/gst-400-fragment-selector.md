**A PR's changelog.d fragment no longer brings back every paid gate case.** Since fragments became the way every PR records its CHANGELOG entry (v1.91.342.0), the PR eval selector read each `changelog.d/<slug>.md` as an unknown dependency and restored the full gate, so it saved nothing on any PR (GST-400, found on #3668).

### Fixed
- **`scripts/test-pr-profile.ts`** treats a `.md` file directly in the ship policy's `changelog_fragments.dir` as having no eval dependents. Other files in that folder, nested files, and a touchfile that names a fragment still select as before.
- **`test/helpers/test-selection.ts`** lists both paths of a renamed file, so moving a file into `changelog.d/` or `docs/` still selects the cases its old path fed.

### Tests
- `test/test-pr-profile.test.ts` covers a fragment-only PR (no full fallback, no cases), other files in the folder, and a touchfile that names a fragment; `test/changed-files-union.test.ts` covers a rename.
