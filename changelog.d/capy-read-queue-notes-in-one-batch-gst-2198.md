---
important: blocker
---
- **`gstack-ship-queue land --pin` and the first `ready` on a head no longer spend 15 s re-reading the queue notes.** Rebuilding local queue state from `refs/notes/gstack-trains` ran one `git cat-file blob` process per note, so every land and first READY took 14 to 15 s on the live 1,442 notes and grew about 8 s a week, on course to pass the 120 s command timeout in about three months, where a killed land leaves the land lock held. All the notes are now read by one `git cat-file --batch` process, which takes about 120 ms per rebuild on the same notes and restores byte-identical records. Malformed, empty and wrong-schema notes are still skipped, and nothing else changed (GST-2198).
