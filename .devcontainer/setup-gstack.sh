#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$HOME/.claude/skills"

mkdir -p "$SKILL_DIR"

target="$SKILL_DIR"

# Copy repo contents into ~/.claude/skills without deleting existing files.
cp -a "$REPO_ROOT"/. "$target"/

echo "Skill directory: $SKILL_DIR"
echo "Copied project root into: $target"
