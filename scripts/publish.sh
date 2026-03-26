#!/usr/bin/env bash
set -euo pipefail

# ─── publish.sh ──────────────────────────────────────────────────────────────
# Publish gstack skills to ~/.claude/skills/ via symlinks.
# Creates $SKILLS_DIR/gstack/ with shared assets and skill dirs, then
# creates discovery symlinks so Claude finds each skill at $SKILLS_DIR/<skill>.
# ─────────────────────────────────────────────────────────────────────────────

# ─── Flag parsing ────────────────────────────────────────────────────────────

DRY_RUN=false
FORCE=false
SKILLS_DIR_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --skills-dir)
      if [[ -z "${2:-}" ]]; then
        echo "Missing value for --skills-dir" >&2
        echo "Usage: publish.sh [--dry-run] [--force] [--skills-dir <path>]" >&2
        exit 1
      fi
      SKILLS_DIR_OVERRIDE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: publish.sh [--dry-run] [--force] [--skills-dir <path>]" >&2
      exit 1
      ;;
  esac
done

# ─── Determine directories ──────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="${SKILLS_DIR_OVERRIDE:-$HOME/.claude/skills}"
GSTACK_DIR="$SKILLS_DIR/gstack"

echo "Source:  $SOURCE_DIR"
echo "Target:  $GSTACK_DIR"
echo "Skills:  $SKILLS_DIR"
[ "$DRY_RUN" = true ] && echo "Mode:    dry-run"
[ "$FORCE" = true ] && echo "Force:   yes"
echo ""

# ─── Helpers ─────────────────────────────────────────────────────────────────

run_cmd() {
  if [ "$DRY_RUN" = true ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

asset_count=0
skill_count=0
discovery_count=0
skip_count=0

# ─── Step 1: Create gstack dir ──────────────────────────────────────────────

echo "==> Creating gstack directory"
run_cmd mkdir -p "$GSTACK_DIR"

# ─── Step 2: Symlink shared assets (not inside a skill dir) ─────────────────

echo ""
echo "==> Deploying shared assets"

# bin/ directory
echo "  bin/ -> $SOURCE_DIR/bin"
run_cmd ln -snf "$SOURCE_DIR/bin" "$GSTACK_DIR/bin"
asset_count=$((asset_count + 1))

# ETHOS.md
echo "  ETHOS.md -> $SOURCE_DIR/ETHOS.md"
run_cmd ln -snf "$SOURCE_DIR/ETHOS.md" "$GSTACK_DIR/ETHOS.md"
asset_count=$((asset_count + 1))

# SKILL.md (root skill)
echo "  SKILL.md -> $SOURCE_DIR/SKILL.md"
run_cmd ln -snf "$SOURCE_DIR/SKILL.md" "$GSTACK_DIR/SKILL.md"
asset_count=$((asset_count + 1))

# ─── Step 3: Symlink skill directories ──────────────────────────────────────

echo ""
echo "==> Deploying skill directories"

for skill_md in "$SOURCE_DIR"/*/SKILL.md; do
  skill_path="$(dirname "$skill_md")"
  skill_name="$(basename "$skill_path")"

  # Skip node_modules
  [ "$skill_name" = "node_modules" ] && continue

  echo "  $skill_name/ -> $SOURCE_DIR/$skill_name"
  run_cmd ln -snf "$SOURCE_DIR/$skill_name" "$GSTACK_DIR/$skill_name"
  skill_count=$((skill_count + 1))
done

# ─── Step 4: Create discovery symlinks ───────────────────────────────────────

echo ""
echo "==> Creating discovery symlinks"

shopt -s nullglob
for skill_dir in "$GSTACK_DIR"/*/; do
  [ ! -d "$skill_dir" ] && continue
  skill_name="$(basename "$skill_dir")"
  target="$SKILLS_DIR/$skill_name"

  # If it's already a symlink or doesn't exist, create/update
  if [ -L "$target" ] || [ ! -e "$target" ]; then
    echo "  $skill_name -> gstack/$skill_name"
    run_cmd ln -snf "gstack/$skill_name" "$target"
    discovery_count=$((discovery_count + 1))
  elif [ "$FORCE" = true ]; then
    echo "  $skill_name -> gstack/$skill_name (overwriting real directory)"
    run_cmd rm -rf "$target"
    run_cmd ln -snf "gstack/$skill_name" "$target"
    discovery_count=$((discovery_count + 1))
  else
    echo "  WARNING: Skipping $skill_name — real directory exists. Use --force to overwrite."
    skip_count=$((skip_count + 1))
  fi
done
shopt -u nullglob

# ─── Step 5: Stamp version ──────────────────────────────────────────────────

echo ""
echo "==> Stamping version"

VERSION_COMMIT="$(cd "$SOURCE_DIR" && git rev-parse HEAD 2>/dev/null || echo "unknown")"
VERSION_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VERSION_CONTENT="$VERSION_COMMIT $VERSION_DATE"

echo "  $VERSION_CONTENT"
if [ "$DRY_RUN" = true ]; then
  echo "  [dry-run] write $GSTACK_DIR/.publish-version"
else
  echo "$VERSION_CONTENT" > "$GSTACK_DIR/.publish-version"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "==> Done"
echo "  Skills linked:     $skill_count"
echo "  Discovery links:   $discovery_count"
echo "  Shared assets:     $asset_count"
echo "  Skipped:           $skip_count"
echo "  Version:           $VERSION_CONTENT"
