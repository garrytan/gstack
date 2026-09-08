#!/usr/bin/env bash
# Migration: v1.82.0.0 — /claude becomes /claude-code on non-Claude hosts.
# Affected: existing generated skills, including copied and dangling installs.
# The same helper runs before setup builds, so replacements are installed before
# shared old renders are retired. This post-setup pass repairs missed upgrades.
# Idempotent and non-fatal: foreign entries and failed replacements stay intact.
set -u
INSTALL_DIR="${GSTACK_INSTALL_DIR:-$HOME/.claude/skills/gstack}"
if [ -f "$INSTALL_DIR/bin/gstack-migrate-claude-code" ] && command -v bun >/dev/null 2>&1; then
  bun "$INSTALL_DIR/bin/gstack-migrate-claude-code" --install-dir "$INSTALL_DIR" || true
fi
exit 0
