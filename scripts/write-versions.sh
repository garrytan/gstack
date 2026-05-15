#!/usr/bin/env bash
# Write the current git HEAD SHA to dist/.version files for each compiled
# binary. An empty file is acceptable if git is unavailable; the setup script
# has a safety net that overwrites missing/empty .version files at install
# time (see setup, around the BROWSE_BIN build block).
#
# Why this is a separate script instead of inline in package.json's build
# script: Bun's bundled shell on Windows rejects subshells-with-redirection
# (`( cmd ) > file`), bash brace groups (`{ cmd; } > file`), and multiple
# redirections on one command (`cmd 2>/dev/null > file`). All three are
# needed to compose the previous inline form, so we delegate to bash which
# handles every variant.

HEAD=$(git rev-parse HEAD 2>/dev/null || true)
printf '%s\n' "$HEAD" > browse/dist/.version
printf '%s\n' "$HEAD" > design/dist/.version
printf '%s\n' "$HEAD" > make-pdf/dist/.version
