**/ship's review depth now follows what the code does, not what a file is named (GST-1177).** An executable file stays code wherever it sits, and code that seals eval custody or decides what reaches an outside model now gets full review. Over the last 200 commits on main, no commit's review depth went down; five went up, including the secret-egress fix in #3921 that had been planned light.

### Changed
- **An executable is code whatever its name or folder.** A file with the exec bit or a `#!` first line, like `scripts/logs/prune` or a runnable `*.out`, no longer counts as a run log or data. If gstack can't read a file's mode or first bytes, it treats the file as executable.
- **Sealed custody and outside-model egress are security risk.** Paths naming seal, sealed, custody or egress, and code lines that call a redaction function, import a redaction or outside-voice module, or set a `SECRET` or `CREDENTIAL` constant to a regex now plan full depth (harness-evals#237, #3921).

### Fixed
- **The outside voice's path-scoped slice no longer drops files with quoted or spaced names.** A file git prints with a quoted header, which can happen when the name has a tab or non-ASCII characters, was either glued onto the file before it or silently left out of a diff over 2 MB. Now each one is its own file, and the brief names it when it's left out.
- **docs/ship-policy.md describes the `review` policy key** and the `risk` and `mode` fields of the receipt's `review_depth` record.
