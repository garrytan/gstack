**`gstack-wtree` works again in a repository that gitignores `.bun/`.** Since GST-421, its `git add -A` carried an exclude pathspec naming `.bun`, and git refuses a pathspec naming an ignored path with exit 1. Every fingerprint call then failed, which broke `gstack-review-log --start`, the evidence checks and /ship in harness-evals (HARN-1, HARN-7, harness-evals#148; GST-449).

### Fixed
- **The `.bun/` exclude applies only when the root `.bun/` exists and is not ignored.** The check reads the ignore rules alone (`git check-ignore --no-index`), so a file still tracked under an ignored `.bun/` doesn't bring the failure back. An ignored `.bun/` already stays out of `git add -A`, so the fingerprint is the same either way.

### Tests
- `test/evidence.test.ts`: with `.bun/` or `/.bun` in `.gitignore`, `gstack-wtree` prints a tree and a lane that writes `.bun/` grades FRESH. With a file tracked under an ignored `.bun/`, the tree matches a plain `git add -A`, and editing or deleting that file changes it. The existing unignored `.bun/` cases still pass.
