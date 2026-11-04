---
bump: minor
---
- **Versions at release under `merge: direct`.** `gstack-release-stamp open` stamps `origin/main` with the new `gstack-restamp --release`, which folds every `changelog.d` fragment under one new CHANGELOG heading, bumps VERSION and `package.json` by the highest fragment bump, reruns the release tool and moves tentative `*_KEY_VERSION` constants. It then pushes `release/<version>` and opens the release PR. `gstack-ship-queue land --pin` lands a `release/<version>` head without a /ship receipt, but only when it is exactly that stamp (`RELEASE_STAMP_INVALID` otherwise), and the Version Gate applies the same check. This lets the stable cut tag a new version again now that PRs land unstamped.
