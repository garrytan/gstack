#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$HOME/.claude/skills"

mkdir -p "$SKILL_DIR"

project_name="$(basename "$REPO_ROOT")"
target="$SKILL_DIR/$project_name"

# Ensure target exists, then copy repo contents over it without deleting extras.
mkdir -p "$target"
cp -a "$REPO_ROOT"/. "$target"/

echo "Skill directory: $SKILL_DIR"
echo "Copied project: $project_name -> $target"
