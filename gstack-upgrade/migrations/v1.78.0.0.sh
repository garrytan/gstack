#!/usr/bin/env bash
# Migration: v1.78.0.0 — carry feature-discovery acknowledgements to GSTACK_HOME
# (#2728 absorption follow-through).
#
# Why a migration: pre-v1.78, `gstack-skill-start` gated the one-time feature
# prompts (.feature-prompted-continuous-checkpoint, .feature-prompted-model-
# overlay) on marker files BESIDE THE INSTALL — which, for project-local
# symlink installs, resolved into the project repo and left machine-state
# droppings in checkouts (#2728). v1.78 reads them from GSTACK_HOME. Without
# this copy, every existing install that already answered those prompts gets
# re-prompted once per feature.
#
# Idempotent: existing destination markers are left untouched. Non-fatal
# throughout — a failed copy just means one benign re-prompt.
set -u

INSTALL_DIR="${GSTACK_INSTALL_DIR:-$HOME/.claude/skills/gstack}"
GH="${GSTACK_HOME:-$HOME/.gstack}"

mkdir -p "$GH" 2>/dev/null || exit 0

for m in .feature-prompted-continuous-checkpoint .feature-prompted-model-overlay; do
  if [ -f "$INSTALL_DIR/$m" ] && [ ! -f "$GH/$m" ]; then
    touch "$GH/$m" 2>/dev/null && echo "migrated: $m → $GH"
  fi
done

exit 0
