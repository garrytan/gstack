#!/usr/bin/env bash
# Standalone gstack installer for Claude Code Web environments
# where cdn.playwright.dev is blocked (403).
#
# Installs skills only — no Playwright, no browse binary.
# Clones from main so "Sync fork" keeps working.
#
# Usage: put this in your __init__ hook or source it.
set -euo pipefail

GSTACK_REPO="https://github.com/kroffske/gstack.git"
GSTACK_DIR="$HOME/.gstack-install"

# 1. Clone gstack from main (shallow, one-time)
if [ ! -d "$GSTACK_DIR" ]; then
  git clone --depth 1 "$GSTACK_REPO" "$GSTACK_DIR"
fi

# 2. Symlink root into ~/.claude/skills/gstack
mkdir -p ~/.claude/skills
ln -snf "$GSTACK_DIR" ~/.claude/skills/gstack

# 3. Install deps + generate skill docs (no Playwright needed)
cd "$GSTACK_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
bun run gen:skill-docs

# 4. Symlink individual skill dirs so Claude discovers them
for skill_dir in */; do
  [ -f "$skill_dir/SKILL.md" ] || continue
  skill_name="${skill_dir%/}"
  [ "$skill_name" = "node_modules" ] && continue
  target="$HOME/.claude/skills/$skill_name"
  if [ -L "$target" ] || [ ! -e "$target" ]; then
    ln -snf "gstack/$skill_name" "$target"
  fi
done

# 5. Global state dir
mkdir -p "$HOME/.gstack/projects"

echo "gstack ready (skills only, no /browse)."
