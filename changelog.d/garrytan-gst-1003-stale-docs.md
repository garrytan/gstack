### Changed

- `gstack-factory-scorecard` now counts a PR as "at the cap" once it reaches 2 review passes, the two-round cap the review policy sets, instead of 3. The default `--pass-cap` is 2, and the "Review passes per PR" benchmark reads "median 1 pass, few at the cap". Pass `--pass-cap 3` to get the old count. Rows from earlier weeks in `trend.csv` were counted at the old cap, and each row names the cap it used.

### Docs

- CLAUDE.md now describes how gstack versions its own PRs today: a branch writes its entry as `changelog.d/<branch-slug>.md` and never edits VERSION, package.json or CHANGELOG.md, and the merge train's stamp assigns the version (`bump: minor` or `bump: major` front matter asks for more than a patch). The old text said to claim a version slot with `bin/gstack-next-version`.
- docs/CHANGELOG_STYLE.md, which CLAUDE.md says to read before writing an entry, now describes the same fragment flow: what goes in the fragment, when to add `bump:` front matter, and what to check after merging main. It no longer tells a branch to bump VERSION or claim a slot with `bin/gstack-next-version`.
- docs/ship-policy.md marks the queue-side procedure as being for repos on `stamp-at-merge` without changelog fragments, and points gstack's own PRs to the fragment flow and `train land`. The old link to that section still works.
