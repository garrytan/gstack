---
important: blocker
---
**Step 11.5 keeps a reviewed head current across base-only merges.** When a merge lane merges main into a PR after its review, `gstack-review-read` now reads the review rows CURRENT if every commit since the review is a clean merge of the base and the branch's own patch is byte-identical, so a /ship run that stopped before its receipt finishes without another review round (harness-evals#515). An own edit, a conflict resolution, an edit inside a merge, base context moved beside the branch's hunks or an uncommitted change still reads STALE and says which.
