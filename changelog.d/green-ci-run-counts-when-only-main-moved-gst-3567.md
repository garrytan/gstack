---
important: blocker
---
**/ship's final CI check no longer makes you rerun CI just because main moved.** A green pull request run that tested your branch merged onto a newer main now counts for your branch when your own changes in that merge are byte-identical to your branch's, so main changed only files you leave alone; before, `gstack-ship-release accept` refused it with `tree_mismatch` and busy repos never converged. It still refuses when main also changed one of your files or the run tested another commit, and a `CARRY_DIAGNOSIS:` line says which. Landing still checks the merged tree with `land.merged_ci`. docs/ship-policy.md#ci-carry-base-moved (GST-3567)
