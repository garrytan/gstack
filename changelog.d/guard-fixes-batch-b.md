---
important: security
---
**The destructive-command check catches an abbreviated `--no-dry-run`, and two over-catches are gone.** `git push -fn --no-dry origin main` (git reads any unambiguous prefix of `--no-dry-run`) is now denied like the full spelling. A `--no-dry-run` that git reads as the value of `-o`/`--push-option` no longer counts as undoing `-n`, and a redirect to a disk-like name directly inside `/dev/shm` or `/dev/fd` is no longer hard-denied; climbing out of those folders, other `/dev` spellings and real disks still deny.
