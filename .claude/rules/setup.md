---
paths:
  - "setup"
  - "test/setup-windows-fallback.test.ts"
---

# Setup symlink hardening (v1.38.0.0+)

Every link site in `setup` MUST route through the `_link_or_copy SRC DST` helper
near the `IS_WINDOWS` detection. On Windows without Developer Mode, plain
`ln -snf` produces frozen file copies that don't refresh on `git pull` — silent
staleness across every host adapter. The helper preserves `ln -snf` on Unix and
switches to `cp -R` / `cp -f` on Windows.

`test/setup-windows-fallback.test.ts` enforces a static invariant: a single raw
`ln` call outside the helper body fails CI. Windows users get a one-line note
from `_print_windows_copy_note_once` reminding them to re-run `./setup` after
every `git pull`.
