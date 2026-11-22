---
important: data-loss
---
- **`gstack-uninstall` no longer deletes a project's committed `.gstack` files or unsaved worktree work (GST-2197).** A plain uninstall now removes only the files git ignores under `.gstack/`, keeps a `.gstack/` that is its own git repository, and stops with exit 2, before removing anything, when a checkout under `.gstack-worktrees/` has uncommitted changes, commits no branch holds, or a lock. It also checks every folder it is about to delete (each gstack install, the per-skill folders and `~/.gstack`) for unsaved git work first. Pass `--force-worktrees` to delete dirty `.gstack-worktrees/` checkouts anyway.
