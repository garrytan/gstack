**`gstack-wtree` works again in a repository that gitignores `.bun/`.** Since GST-421, its `git add -A` carried an exclude pathspec naming `.bun`, and git refuses a pathspec naming an ignored path with exit 1. Every fingerprint call then failed, which broke `gstack-review-log --start`, the evidence checks and /ship in harness-evals (HARN-1, HARN-7, harness-evals#148; GST-449).

### Fixed
- **The `.bun/` exclude applies only when the root `.bun/` exists and is not ignored.** An ignored `.bun/` already stays out of `git add -A`, so the fingerprint is the same either way.

### Tests
- `test/evidence.test.ts`: with `.bun/` or `/.bun` in `.gitignore`, `gstack-wtree` prints a tree and a lane that writes `.bun/` grades FRESH. The existing unignored `.bun/` cases still pass.
