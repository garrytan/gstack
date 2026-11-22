---
important: blocker
---
**`/ship` on a branch stacked on another branch can now clear its remote test gate from a green CI run.** `gstack-pregate clear --run` reads the run profiles of the base the record was made against instead of `origin/HEAD`'s, and the CI reuse inside `gstack-pregate --base <branch>` clears the gate the same way; `--base` naming a different branch still refuses. docs/pregate.md#run-evidence (GST-3381)
