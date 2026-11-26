---
important: blocker
---
**`/gstack-ship` now handles very large results PRs.** A repository's `review_exclude_paths` can list up to 256 patterns instead of 64. When a reviewer's diff is still too big, the suggested fix no longer offers to hide `docs/` and never prints a policy gstack would refuse. The pre-merge secrets check and `gstack-banned-terms` read a diff of any size instead of failing past 256 MB. `gstack-review-plan` matches exclusion patterns and searches for files that name excluded paths with a fixed number of git calls, which took a 16,000-file results PR from 180 s to 100 s, and the docs-only check searches for references to every changed doc in one pass instead of one search per file. A PR body may list its `Ruled note:` lines as `- ` or `* ` bullets.
