#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_LINK_DIR="$HOME/.copilot/skills"

mkdir -p "$SKILL_LINK_DIR"

# Keep generated skill links out of git status.
cat > "$SKILL_LINK_DIR/.gitignore" <<'EOF'
*
!.gitignore
EOF

# Find skill docs and symlink their parent directories into ~/.copilot/skills.
declare -A seen_dirs=()
linked=()
skipped=()

while IFS= read -r skill_file; do
  skill_dir="$(dirname "$skill_file")"

  if [[ -n "${seen_dirs["$skill_dir"]+x}" ]]; then
    continue
  fi
  seen_dirs["$skill_dir"]=1

  if [[ "$skill_dir" == "$REPO_ROOT" ]]; then
    skill_name="$(basename "$REPO_ROOT")"
  else
    skill_name="$(basename "$skill_dir")"
  fi

  target="$SKILL_LINK_DIR/$skill_name"

  if [[ -e "$target" && ! -L "$target" ]]; then
    skipped+=("$skill_name")
    continue
  fi

  ln -snf "$skill_dir" "$target"
  linked+=("$skill_name")
done < <(
  find "$REPO_ROOT" \
    \( -path "$REPO_ROOT/.git" -o -path "$REPO_ROOT/node_modules" -o -path "$REPO_ROOT/.agents" -o -path "$REPO_ROOT/.claude" -o -path "$REPO_ROOT/.copilot" \) -prune -o \
    -type f \( -name "SKILL.md" -o -name "SKILLS.md" \) -print
)

echo "Skill link directory: $SKILL_LINK_DIR"
if [[ ${#linked[@]} -gt 0 ]]; then
  echo "Linked skills: ${linked[*]}"
else
  echo "No skills linked."
fi

if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "Skipped (non-symlink targets already exist): ${skipped[*]}"
fi
