**`gstack-ship-preflight` stops when it can't read origin's default branch, instead of guessing it from a local ref.** When `git ls-remote --symref origin HEAD` failed and the fetch worked, preflight fell back to the local `origin/HEAD`. With no local `origin/HEAD` it went on from the default branch itself and merged the given base into it. When a PR-branch clone's `origin/HEAD` named the feature branch, it refused that branch as "on the base branch". Both now stop with `git ls-remote origin HEAD failed: …; restore access first` before anything merges. The default-branch check now runs after the fetch, so a failed fetch still reports the fetch.

### Fixed
- **`docs/eval-calls.md`, `docs/eval-models.md`**: the default `--base` is described as base resolution now works: origin/HEAD's branch unless that is the checked-out branch, then the PR's base, `main` or `master`.

### Tests
- `test/ship-preflight.test.ts`: with `ls-remote` failing and the fetch working, preflight stops before merging both on the default branch with no local `origin/HEAD` (on main it exited 0 and merged `release` into `main`) and on a feature branch that the local `origin/HEAD` names (on main it stopped as "on the base branch").
