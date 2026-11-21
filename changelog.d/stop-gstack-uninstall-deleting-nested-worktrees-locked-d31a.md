---
important: data-loss
---
**`gstack-uninstall` no longer deletes work it cannot get back (GST-2268).** It now stops, before anything is removed, when a checkout under `.gstack-worktrees/` is nested inside another one and has uncommitted changes or commits no branch holds, when a worktree is locked (even with `--force-worktrees`), or when a submodule inside a lane has commits no remote-tracking branch contains. A project `.gstack/` folder that is its own git repository is kept and named instead of deleted. Every check runs again after the confirmation prompt, so a checkout edited while the prompt waits is still kept. A clean worktree on a branch is still removed by a plain `--force`, and `docs/uninstall.md` describes each case.
