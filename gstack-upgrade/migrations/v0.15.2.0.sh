#!/usr/bin/env bash
# Migration: v0.15.2.0 — Fix skill directory structure for unprefixed discovery
#
# What changed: setup now creates real directories with SKILL.md symlinks
# inside instead of directory symlinks. The old pattern (qa -> gstack/qa)
# caused Claude Code to auto-prefix skills as "gstack-qa" even with
# --no-prefix, because Claude sees the symlink target's parent dir name.
#
# What this does: runs gstack-relink to recreate all skill entries using
# the new real-directory pattern. Idempotent — safe to run multiple times.
#
# Affected: users who installed gstack before v0.15.2.0 with --no-prefix
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -x "$SCRIPT_DIR/bin/gstack-relink" ]; then
  echo "  [v0.15.2.0] Fixing skill directory structure..."
  "$SCRIPT_DIR/bin/gstack-relink" 2>/dev/null || true
fi
