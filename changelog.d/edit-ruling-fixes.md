---
important: blocker
---
### Fixed

- **An owner can now let a small edit made after the final review ship as a disclosed note, and /ship honours it.** Before, an edit after the read-only final review stopped `gstack-ship-release finish` with no way to record the owner's "ship it with the note", so the run stayed stuck however the owner ruled. The owner's ruling is now one `gstack-approvals rule --finding edit:<path> --head <stop head>` per edited path, and the `gstack-review-plan --post-review` stop prints that command for each of the PR's own edited paths, shell-quoted so it pastes safely. finish then accepts exactly those paths, at exactly the ruled bytes, prints a `RULED_EDIT:` line for each, and the PR body lists each ruling. It refuses, with a `RULED_EDIT_REFUSED:` line and the reason, a path edited again after its ruling, a deletion, a path git cannot read, and a path whose name reaches finish with a replacement character, so a ruling can never clear an edit to a different file.
