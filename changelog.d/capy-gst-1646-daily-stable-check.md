**Important fixes reach stable within a day, and stable is never more than a week stale.** The Stable release workflow now runs every day at 14:00 UTC as a daily check (R74).

### Added
- A changelog fragment can mark its change important with `important: security|regression|data-loss|blocker` in its front matter. The daily check cuts stable once it is 24 hours old when a gated change stable lacks carries the field.
- The daily check also forces a cut when stable is 7 days old and main has gated changes. Monday and Thursday stay the regular cuts with the 72-hour floor. On a day with nothing to do it changes nothing and logs why.
- A due cut that finds no release PR reports `NO_RELEASE_PR: important change waiting, no release PR` and goes red. A week-old stable whose main has nothing newer gated reports `STABLE_STALE`.
- docs/releases.md documents the daily check, when the Captain stamps a release PR, the exit codes, and the exact commands to roll stable back.
