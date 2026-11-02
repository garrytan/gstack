---
bump: patch
---
- **Opening a tab for one browser session no longer undoes another caller's tab switch.** If a different caller switched the active tab while a session's new tab was opening, the daemon used to switch back; it now keeps the newer choice.
- **`gstack-artifact validate` catches a deleted shadow record.** A revision the journal says was recorded, but whose record file is gone, now fails as `ARTIFACT_STALE` instead of passing.
- **A shadow that fails while saving its record is journaled and never stops the run.** The failure is written as `shadow_failed` under the run lock and its lease is dropped; if the lock stays taken, the lease expires and the next command settles that revision.
