---
important: blocker
---
- **Under a merge-train policy, `gstack-ship-queue ready` no longer reports READY when its note never reached origin.** `land --pin` reads the READY note from origin's `refs/notes/gstack-trains`, but `ready` exited 0 even when it couldn't push that note, so a lane sent READY and the land was refused with `QUEUE_NOT_READY` (#4245 lost a land round this way). After pushing, `ready` now fetches origin's notes ref back and prints `notes pushed` only when origin holds the note. If three tries fail, or the push exits 0 and origin still lacks the note, it refuses with `QUEUE_READY_NOTE_UNPUSHED` and keeps the local receipt, so rerunning the same `ready` command once the push works records it (GST-2242).
