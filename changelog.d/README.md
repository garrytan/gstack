# CHANGELOG fragments

A PR adds its CHANGELOG entry here as `changelog.d/<branch-slug>.md`: the entry text only, with no `## [x]` heading, and `bump: minor` or `bump: major` front matter only when the change warrants more than a patch. It never edits VERSION, `package.json`'s version or a released CHANGELOG section. The merge step (`gstack-ship-queue land`, or `train land` in a stamped train) assigns the version, folds every fragment into one CHANGELOG section and deletes the files. This README is skipped. See docs/ship-policy.md#changelog-fragments.
