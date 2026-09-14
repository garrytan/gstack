#!/usr/bin/env bash
# Migration: v1.1.3.0 — Remove stale /checkpoint skill installs
#
# Claude Code ships /checkpoint as a native alias for /rewind, which was
# shadowing the gstack checkpoint skill. The skill has been split into
# /context-save + /context-restore. This migration removes the old on-disk
# install so Claude Code's native /checkpoint is no longer shadowed.
#
# Ownership guard: the script only removes the install IF it owns it —
# i.e., the directory or its SKILL.md is a symlink resolving inside
# ~/.claude/skills/gstack/. A user's own /checkpoint skill (regular file,
# or symlink pointing elsewhere) is preserved.
#
# Three supported install shapes to handle:
#   1. ~/.claude/skills/checkpoint is a directory symlink into gstack.
#   2. ~/.claude/skills/checkpoint is a regular directory whose ONLY file
#      is a SKILL.md symlink into gstack (gstack's prefix-install shape).
#   3. Anything else → leave alone, print notice.
#
# Idempotent: missing paths are no-ops.
set -euo pipefail

# Guard: refuse to run if HOME is unset or empty. With `set -u`, unset HOME
# errors out, but HOME="" (possible under sudo-without-H, systemd units, some
# CI runners) survives and produces dangerous absolute paths like
# "/.claude/skills/...". Abort cleanly.
if [ -z "${HOME:-}" ]; then
  echo "  [v1.1.3.0] HOME is unset or empty — skipping migration." >&2
  exit 0
fi

SKILLS_DIR="${HOME}/.claude/skills"
OLD_TOPLEVEL="${SKILLS_DIR}/checkpoint"
OLD_NAMESPACED="${SKILLS_DIR}/gstack/checkpoint"
GSTACK_ROOT_REAL=""

# Helper: canonical-path a target (symlink-safe). Prints the resolved path, or
# empty on failure (broken symlink, ENOENT, ELOOP). Both realpath AND the python3
# fallback are tried — a single tool failure shouldn't defeat the ownership
# check. Returns empty string if both fail.
resolve_real() {
  local target="$1"
  local out=""
  if command -v realpath >/dev/null 2>&1; then
    out=$(realpath "$target" 2>/dev/null || true)
  fi
  if [ -z "$out" ] && command -v python3 >/dev/null 2>&1; then
    out=$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$target" 2>/dev/null || true)
  fi
  printf '%s' "$out"
}

# Resolve the canonical path of the gstack skills root. If gstack isn't
# installed here, there's nothing to migrate.
if [ -d "${SKILLS_DIR}/gstack" ]; then
  GSTACK_ROOT_REAL=$(resolve_real "${SKILLS_DIR}/gstack")
fi

# Helper: does $1 (canonical path) live inside $2 (canonical path)?
path_inside() {
  local inner="$1"
  local outer="$2"
  [ -n "$inner" ] && [ -n "$outer" ] || return 1
  case "$inner" in
    "$outer"|"$outer"/*) return 0;;
    *) return 1;;
  esac
}

removed_any=0

# --- Shape 1: top-level ~/.claude/skills/checkpoint
if [ -L "$OLD_TOPLEVEL" ]; then
  # Directory symlink (or file symlink). Canonicalize and check ownership.
  target_real=$(resolve_real "$OLD_TOPLEVEL")
  if [ -n "$GSTACK_ROOT_REAL" ] && path_inside "$target_real" "$GSTACK_ROOT_REAL"; then
    rm -- "$OLD_TOPLEVEL"
    echo "  [v1.1.3.0] Removed stale /checkpoint symlink (was shadowing Claude Code's /rewind alias)."
    removed_any=1
  else
    echo "  [v1.1.3.0] Leaving $OLD_TOPLEVEL alone — symlink target is outside gstack (or unresolvable)."
  fi
elif [ -d "$OLD_TOPLEVEL" ]; then
  # Regular directory. Only remove if it contains exactly one file named
  # SKILL.md that's a symlink into gstack (gstack's prefix-install shape).
  # Use find to count real files, ignoring .DS_Store (macOS sidecars).
  file_count=$(find "$OLD_TOPLEVEL" -maxdepth 1 -type f -not -name '.DS_Store' -not -name '._*' 2>/dev/null | wc -l | tr -d ' ')
  symlink_count=$(find "$OLD_TOPLEVEL" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')
  if [ "$file_count" = "0" ] && [ "$symlink_count" = "1" ] && [ -L "$OLD_TOPLEVEL/SKILL.md" ]; then
    target_real=$(resolve_real "$OLD_TOPLEVEL/SKILL.md")
    if [ -n "$GSTACK_ROOT_REAL" ] && path_inside "$target_real" "$GSTACK_ROOT_REAL"; then
      # Strip macOS sidecars first (not user content), then remove the dir.
      find "$OLD_TOPLEVEL" -maxdepth 1 \( -name '.DS_Store' -o -name '._*' \) -type f -delete 2>/dev/null || true
      rm -r -- "$OLD_TOPLEVEL"
      echo "  [v1.1.3.0] Removed stale /checkpoint install directory (gstack prefix-mode)."
      removed_any=1
    else
      echo "  [v1.1.3.0] Leaving $OLD_TOPLEVEL alone — SKILL.md symlink target is outside gstack."
    fi
  else
    echo "  [v1.1.3.0] Leaving $OLD_TOPLEVEL alone — not a gstack-owned install (has custom content)."
  fi
fi
# Missing → no-op (idempotency).

# --- Shape 2: ~/.claude/skills/gstack/checkpoint/
# Ownership guard applies here too: only remove if this path resolves inside the
# gstack skills root. If a user replaced the directory with a symlink pointing
# elsewhere (e.g., at their own fork), respect it.
if [ -L "$OLD_NAMESPACED" ]; then
  target_real=$(resolve_real "$OLD_NAMESPACED")
  if [ -n "$GSTACK_ROOT_REAL" ] && path_inside "$target_real" "$GSTACK_ROOT_REAL"; then
    rm -- "$OLD_NAMESPACED"
    echo "  [v1.1.3.0] Removed stale ~/.claude/skills/gstack/checkpoint symlink."
    removed_any=1
  else
    echo "  [v1.1.3.0] Leaving $OLD_NAMESPACED alone — symlink target is outside gstack."
  fi
elif [ -d "$OLD_NAMESPACED" ]; then
  # Regular directory. This is the gstack-prefix install location. Check that
  # it resolves to a path inside the gstack root (it should, unless someone
  # hand-edited the tree).
  target_real=$(resolve_real "$OLD_NAMESPACED")
  if [ -n "$GSTACK_ROOT_REAL" ] && path_inside "$target_real" "$GSTACK_ROOT_REAL"; then
    rm -rf -- "$OLD_NAMESPACED"
    echo "  [v1.1.3.0] Removed stale ~/.claude/skills/gstack/checkpoint/ (replaced by context-save + context-restore)."
    removed_any=1
  else
    echo "  [v1.1.3.0] Leaving $OLD_NAMESPACED alone — resolves outside gstack."
  fi
fi

if [ "$removed_any" = "1" ]; then
  echo "  [v1.1.3.0] /checkpoint is now Claude Code's native /rewind alias. Use /context-save to save state and /context-restore to resume."
fi

exit 0
