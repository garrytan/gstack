---
important: data-loss
---
- **`gstack-uninstall` no longer deletes your repo's committed `.gstack/` files or unsaved work in `.gstack-worktrees/` (GST-2197).** Files git tracks under `.gstack/` (ship policy and the like) stay; only the files git ignores are removed, and a `.gstack/` that holds its own git repository is kept with a message saying why. A checkout under `.gstack-worktrees/` with uncommitted changes, commits no branch holds, or no registration as this repository's worktree stops the uninstall before anything is removed (exit 2) unless you pass `--force-worktrees`; a locked worktree stops it either way. Install folders that are git checkouts with unpushed or uncommitted work are refused too.
