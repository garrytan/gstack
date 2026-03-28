---
description: Pulls changes from upstream gstack completely and cleanly reapplies our fork's local agent scripts via rebase.
---

# Sync Upstream

Follow these steps faithfully to ensure the Antigravity local fork configuration tracks closely to the `garrytan/gstack:main` branch.

// turbo-all

1. Add the upstream remote if it is not already configured.
```bash
git remote add upstream https://github.com/garrytan/gstack.git || true
```
2. Fetch the upstream's latest updates without making edits.
```bash
git fetch upstream main
```
3. Attempt to rebase our current integration branch on top of `upstream/main`.
```bash
git rebase upstream/main
```

> [!CAUTION]
> If a merge conflict happens during step 3, STOP EXECUTING THE SCRIPT. Do not auto-run anything else.
> Investigate the conflicting files using `git status` and resolve the differences, prioritizing the upstream versions for `gstack` core files and our versions for anything under `.agents/`.
> Once you resolve the conflicts, execute `git rebase --continue` and notify the user.
