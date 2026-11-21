---
important: blocker
---
**gstack's current files, and so every new shallow gstack install, no longer contain real benchmark tasks.** The router tests used 63 prompts copied from SWE-rebench tasks, and since every install is a clone of the repository, those tasks sat in each user's home and in every eval run that installed gstack. They are replaced with synthetic bug reports and feature requests covering the same routes, and a new free test fails if a SWE-bench-style task id appears anywhere under `test/` or `browse/test/`. Older commits still hold the original prompts, so an install with full git history, such as one pinned to a commit, can still reach them through `git log`.
