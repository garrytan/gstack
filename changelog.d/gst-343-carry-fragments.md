**A PR that moves its CHANGELOG entry into `changelog.d/` keeps its /ship receipt (GST-343).** Since #3654 turned on changelog fragments for gstack, a base merge that moved a PR's `[Unreleased]` entry into `changelog.d/<slug>.md` made `gstack-ship-receipt carry` refuse with RECEIPT_CARRY_PRODUCT_CHANGED. The PR then needed a new review pass for a changelog edit.

### Fixed
- **Carry counts a changelog fragment as release metadata** (`lib/ship-receipt.ts`, `bin/gstack-ship-receipt`). When the base policy sets `changelog_fragments`, each `<dir>/<slug>.md` directly under the directory is metadata, as `CHANGELOG.md` is. The directory's README.md, a nested path, a non-Markdown file and a fragment under a policy without `changelog_fragments` stay product. docs/ship-policy.md lists the fragment under release metadata.

### Tests
- `test/gstack-ship-receipt.test.ts`: a merge-only head that moves the entry into `changelog.d/feat.md` carries as "base merge + release metadata". A README edit in the same merge is refused and named, and so is the same move when the base policy has no `changelog_fragments`.
