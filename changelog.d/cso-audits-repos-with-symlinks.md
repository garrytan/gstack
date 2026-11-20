---
important: blocker
---
**`/cso` now audits repositories that track symlinks.** One symlink anywhere in the checkout, even `CLAUDE.md -> AGENTS.md` or gstack's own `connect-chrome`, used to stop `gstack-cso start` with `UNSAFE_PATH`. Each tracked or nonignored symlink is now listed in the report with its target string, or notes that the target was withheld when it matches a secret pattern and is never followed, so a link to `/etc/passwd`, one that escapes through `..`, a loop or a dangling link is reported and never read. FIFOs, sockets and devices are still refused, and `--paths` now limits that check to the audited directories, so a FIFO outside them no longer blocks the run. Thanks to @nathanshox for the report and first fix (#4540).
