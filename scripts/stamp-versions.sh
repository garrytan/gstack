#!/usr/bin/env bash
# Stamp git HEAD into per-binary .version files and clean up bun build
# temp artifacts.
#
# Extracted from package.json `build` script because Bun Shell on Windows
# doesn't handle `( ... ) > file` (subshell + stdout redirect) reliably
# (oven-sh/bun#11066, #11968) -- chained `&&` builds break midway,
# leaving stale binaries with no version stamp. Real bash (Git Bash,
# WSL, macOS, Linux) handles the same syntax without issue, so isolating
# it in a `.sh` file keeps the build cross-platform.

set -e

GSTACK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GSTACK_DIR"

for dir in browse design make-pdf; do
  ( git rev-parse HEAD 2>/dev/null || true ) > "$dir/dist/.version"
done

rm -f .*.bun-build 2>/dev/null || true
