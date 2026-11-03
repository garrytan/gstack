**/ship's review depth now follows what the code does, not what a file is named (GST-1177).** An executable file stays code wherever it sits and whatever its name, and code that seals eval custody or decides what reaches an outside model now gets full review. Over the last 200 commits on main, no commit's review depth went down. Six gained a risk class, and three of those went from light to full, including the secret-egress fix in #3921 that had been planned light.

### Changed
- **An executable is code whatever its name or folder.** A file with the exec bit, a symlink, or a file whose first line is `#!` counts as code. Examples are `scripts/logs/prune`, a runnable `*.out`, or an executable `.txt` or `.json` script. It no longer counts as a run log, data, config or docs, and its changed lines are read for risk. If gstack can't read a file's mode or first bytes, it treats the file as executable. A deleted file is never counted as executable.
- **Sealed custody and outside-model egress are security risk.** Paths naming seal, sealed, custody or egress now plan full depth (harness-evals#237, #3921). So do code lines that call a redaction function, import a redaction or outside-voice module, or set a `SECRET` or `CREDENTIAL` constant to a regex.
- **The docs credential check reads every docs path**, including docs-named executables, so a script that prints an `Authorization:` header still plans full depth.

### Fixed
- **The outside voice's path-scoped slice no longer drops files with quoted or spaced names.** Git prints a quoted header when a name has a tab or non-ASCII characters. Such a file was either glued onto the file before it or left out of a diff over 2 MB without being listed. Now each one is its own file, and the brief names it when it's left out.
- **`gstack-review-plan` never opens a tracked symlink** to check for `#!` or to read an SVG drawing, so a link to a FIFO can't hang it.
- **docs/ship-policy.md describes the `review` policy key** and the `risk` and `mode` fields of the receipt's `review_depth` record.
