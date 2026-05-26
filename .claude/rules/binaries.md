---
paths:
  - "browse/dist/**"
  - "design/dist/**"
---

# Compiled binaries — NEVER commit browse/dist/ or design/dist/

The `browse/dist/` and `design/dist/` directories contain compiled Bun binaries
(`browse`, `find-browse`, `design`, ~58MB each). These are Mach-O arm64 only — they
do NOT work on Linux, Windows, or Intel Macs. The `./setup` script already builds
from source for every platform, so the checked-in binaries are redundant. They are
tracked by git due to a historical mistake and should eventually be removed with
`git rm --cached`.

**NEVER stage or commit these files.** They show up as modified in `git status`
because they're tracked despite `.gitignore` — ignore them. When staging files,
always use specific filenames (`git add file1 file2`) — never `git add .` or
`git add -A`, which will accidentally include the binaries.
