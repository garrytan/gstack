---
important: data-loss
---
- **`gstack-uninstall` no longer deletes a repo's committed `.gstack/` files or worktrees with unsaved work (GST-2197).** A plain uninstall now keeps the git-tracked files under `.gstack/` (such as ship policy) and removes only the ones git ignores. It also keeps a `.gstack/` that is its own git repository, with a message saying so. It stops with exit 2, before removing anything, when a checkout under `.gstack-worktrees/` has uncommitted changes or commits no branch or tag holds; `--force-worktrees` deletes them anyway. The check runs again after you confirm, so a checkout you edit while the prompt waits is kept.
