**`gstack-ubi sync` and `pack` work on a subdirectory of a git checkout (GST-935).** Packing any folder that sat inside a checkout but was not its root died with "does not appear to be a git repository", after the VM was already up, because pack fetched the checkout's refs from the subdirectory and git only fetches from a repository's root. The gstack-evals launcher syncs `quick/laneb/runner`, so every launch from a git checkout failed at its first sync.

### Fixed
- **A subdirectory packs its own files.** Pack ships the files git lists under that folder (tracked, edited and untracked, not ignored) with no `.git`. A whole-repository `.git` would show the VM every file outside the folder as deleted. Packing a checkout's root and packing a non-git folder work as before.
- **A subdirectory git lists no files under is refused.** When the checkout ignores the folder, pack exits with "pack: git lists no files under <dir>" instead of uploading an empty folder, which a run could otherwise pass on.

### Tests
- `test/ubicloud-runner.test.ts`: packing a subdirectory of a checkout and of a linked worktree ships its tracked, edited and untracked files without a `.git` and leaves out ignored ones, and an ignored subdirectory is refused. This test fails on 1.92.58.0.
