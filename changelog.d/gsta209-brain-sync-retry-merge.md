**brain-sync no longer gets stuck in `push_failed` when another machine changed a file you have edited locally.** After a rejected push, brain-sync fetches and merges the other machine's commits. Git refuses that merge when a file it would update has uncommitted local edits. brain-sync hid git's error and hit the same refusal on every run, so cross-machine sync stopped for good (#3704).

### Fixed
- **The retry merge sets aside local edits to the files it changes and puts them back** (`bin/gstack-brain-sync`). Other local edits stay where they are, file names are never read as patterns, and only the stash entry this run made is put back. A failed merge is aborted, so it never leaves conflict markers or a half-finished merge in `~/.gstack`.
- **When a local edit conflicts with the other machine's change, the other machine's version stays.** The local edit is kept in a git stash. The status names the stash and the exact `git -C ~/.gstack --literal-pathspecs restore --source=<stash> -- <path>` command that brings it back. A later sync never pushes the old local copy over the other machine's change. Files with a merge driver (`*.jsonl`, the union-merged plans) merge as before.
- **`push_failed` now says why.** It carries git's merge reason (for example `CONFLICT (content): Merge conflict in developer-profile.json`) and the real push error line instead of git's `To <remote>` banner.

### Tests
- `test/brain-sync.test.ts`: a dirty file the remote didn't touch, a dirty file the remote also changed (including a second sync and the restore command), local-delete/remote-edit, local-edit/remote-delete, a conflicting file whose name looks like a pattern, a file that never checks out clean, a stash push that saves nothing, and a committed conflict. Five of the eight fail on main.
