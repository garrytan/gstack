---
important: blocker
---
- **`gstack-ship-queue ready` no longer refuses a good receipt because the lane's copy of the base was old.** `ready` read `origin/<base>` as the clone last fetched it, so a lane a few landings behind measured the PR from an older merge base, counted files from PRs that had already landed, and refused with a false `RECEIPT_INVALID field=review_exclude` (gbrain #8991). `ready` now fetches the base before it reads the policy or checks any receipt field, and refuses with the new `QUEUE_BASE_UNFETCHED` when the fetch fails; the stamp path of `land` refuses the same way instead of carrying on with the old ref. The selection itself was already measured from the merge base (the PR's own files), and a new test pins that (GST-2232).
