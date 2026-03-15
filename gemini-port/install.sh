#!/usr/bin/env bash
# install.sh — Install gstack for Gemini CLI
#
# This script:
#   1. Installs npm dependencies for gstack-browse and gstack-setup-browser-cookies
#   2. Generates Gemini-adapted versions of the 6 main skills (from the repo root)
#   3. Links all skills into Gemini CLI via `gemini skills link`
#
# Usage: bash gemini-port/install.sh [--scope workspace|user]
#
# Run from the gstack repo root, or from anywhere — the script finds the repo root.

set -euo pipefail

# Check required dependencies upfront
if ! command -v gemini >/dev/null 2>&1; then
  echo "[install] ERROR: 'gemini' CLI not found in PATH."
  echo "  Install it from: https://github.com/google-gemini/gemini-cli"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[install] ERROR: 'node' not found in PATH."
  echo "  Install Node.js from: https://nodejs.org"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[install] ERROR: 'npm' not found in PATH."
  echo "  Install Node.js (includes npm) from: https://nodejs.org"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[install] ERROR: 'python3' not found in PATH."
  echo "  Install Python 3 from: https://python.org"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GEMINI_PORT="$SCRIPT_DIR"
SCOPE="${1:---scope user}"
# Accept "--scope workspace" or just "workspace"
case "$SCOPE" in
  --scope) SCOPE_FLAG="--scope ${2:-user}" ;;
  workspace|user) SCOPE_FLAG="--scope $SCOPE" ;;
  --scope\ *|*) SCOPE_FLAG="$SCOPE" ;;
esac

BROWSE_BIN='node $HOME/.gemini/skills/gstack-browse/scripts/browse.js'

# Colour helpers (graceful fallback if tput not available)
bold=""; green=""; yellow=""; reset=""
if command -v tput >/dev/null 2>&1; then
  bold=$(tput bold 2>/dev/null || true)
  green=$(tput setaf 2 2>/dev/null || true)
  yellow=$(tput setaf 3 2>/dev/null || true)
  reset=$(tput sgr0 2>/dev/null || true)
fi

log()  { echo "${bold}${green}[install]${reset} $*"; }
warn() { echo "${bold}${yellow}[install]${reset} $*"; }

# ---------------------------------------------------------------------------
# 1. Install npm dependencies
# ---------------------------------------------------------------------------

log "Installing gstack-browse dependencies..."
(cd "$GEMINI_PORT/gstack-browse" && npm install --silent)

log "Installing gstack-setup-browser-cookies dependencies..."
(cd "$GEMINI_PORT/gstack-setup-browser-cookies" && npm install --silent)

# ---------------------------------------------------------------------------
# 2. Generate adapted Gemini skills from main repo SKILL.md files
# ---------------------------------------------------------------------------

# Parallel arrays (bash 3 compatible):  SRC_DIRS[i] maps to SKILL_NAMES[i]
SRC_DIRS=(
  "ship"
  "review"
  "qa"
  "retro"
  "plan-ceo-review"
  "plan-eng-review"
)
SKILL_NAMES=(
  "gstack-ship"
  "gstack-reviewer"
  "gstack-qa"
  "gstack-retro"
  "gstack-ceo"
  "gstack-eng-lead"
)

OUT_DIR="$GEMINI_PORT/generated"
mkdir -p "$OUT_DIR"

adapt_skill() {
  local src_dir="$1"
  local skill_name="$2"
  local src_skill="$src_dir/SKILL.md"

  if [ ! -f "$src_skill" ]; then
    warn "Skipping $skill_name — $src_skill not found"
    return
  fi

  local dest_dir="$OUT_DIR/$skill_name"
  mkdir -p "$dest_dir"

  python3 - "$src_skill" "$dest_dir/SKILL.md" "$skill_name" "$BROWSE_BIN" <<'PYEOF'
import sys
import re

src_path   = sys.argv[1]
dest_path  = sys.argv[2]
skill_name = sys.argv[3]
browse_bin = sys.argv[4]

with open(src_path, 'r') as f:
    text = f.read()

# ── 1. Extract description from frontmatter ──────────────────────────────────
desc_match = re.search(r'^description:\s*\|?\s*\n((?:  .+\n)+)', text, re.MULTILINE)
description = ''
if desc_match:
    description = re.sub(r'^  ', '', desc_match.group(1), flags=re.MULTILINE).strip()
else:
    desc_match2 = re.search(r'^description:\s*["\']?(.+?)["\']?\s*$', text, re.MULTILINE)
    if desc_match2:
        description = desc_match2.group(1).strip()

# ── 2. Strip existing frontmatter block (first --- ... ---) ──────────────────
text = re.sub(r'^---\n.*?^---\n', '', text, count=1, flags=re.DOTALL | re.MULTILINE)

# ── 3. Remove HTML generator comments ────────────────────────────────────────
text = re.sub(r'<!-- AUTO-GENERATED.*?-->\n?', '', text, flags=re.DOTALL)
text = re.sub(r'<!-- Regenerate:.*?-->\n?', '', text, flags=re.DOTALL)

# ── 4. Remove Update Check block ─────────────────────────────────────────────
text = re.sub(
    r'## Update Check \(run first\)\s*```bash.*?```\s*\nIf output shows.*?\n\n',
    '',
    text,
    flags=re.DOTALL
)

# ── 5. Replace $B SETUP block with Gemini path ───────────────────────────────
setup_pattern = re.compile(
    r'## SETUP \(run this check BEFORE any browse command\)\s*'
    r'```bash\s*.*?```\s*\n'
    r'If `NEEDS_SETUP`:.*?(?=\n##|\Z)',
    re.DOTALL
)
gemini_setup = (
    '## SETUP (run before any browse command)\n\n'
    '```bash\n'
    f'B="{browse_bin}"\n'
    'if node --version >/dev/null 2>&1; then\n'
    '  echo "READY"\n'
    'else\n'
    '  echo "NEEDS_SETUP: install Node.js from https://nodejs.org"\n'
    'fi\n'
    '```\n'
)
text = setup_pattern.sub(gemini_setup, text)

# ── 6. Build Gemini frontmatter ───────────────────────────────────────────────
if description:
    if '\n' in description:
        indented = '\n'.join('  ' + l for l in description.splitlines())
        fm = f'---\nname: {skill_name}\ndescription: |\n{indented}\n---\n\n'
    else:
        fm = f'---\nname: {skill_name}\ndescription: {description}\n---\n\n'
else:
    fm = f'---\nname: {skill_name}\n---\n\n'

# ── 7. Clean up excessive blank lines ────────────────────────────────────────
text = re.sub(r'\n{3,}', '\n\n', text)
text = text.lstrip('\n')

with open(dest_path, 'w') as f:
    f.write(fm + text)

print(f'  Adapted: {src_path} → {dest_path}')
PYEOF
}

log "Adapting main skills for Gemini CLI..."
for i in "${!SRC_DIRS[@]}"; do
  adapt_skill "$REPO_ROOT/${SRC_DIRS[$i]}" "${SKILL_NAMES[$i]}"
done

# ---------------------------------------------------------------------------
# 3. Link all skills via `gemini skills link`
# ---------------------------------------------------------------------------

link_skill() {
  local skill_dir="$1"
  local label="$2"
  log "Linking $label..."
  # pipe Y to auto-confirm the "link existing directory?" prompt
  echo "Y" | gemini skills link "$skill_dir" $SCOPE_FLAG 2>&1
}

log "Linking skills into Gemini CLI..."

link_skill "$GEMINI_PORT/gstack-browse"                "gstack-browse"
link_skill "$GEMINI_PORT/gstack-setup-browser-cookies" "gstack-setup-browser-cookies"

for i in "${!SKILL_NAMES[@]}"; do
  link_skill "$OUT_DIR/${SKILL_NAMES[$i]}" "${SKILL_NAMES[$i]}"
done

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
log "Installation complete! Reload skills in Gemini with: /skills reload"
echo ""
echo "  Native skills (Gemini-specific):"
echo "    gstack-browse, gstack-setup-browser-cookies"
echo ""
echo "  Adapted skills (generated from main repo):"
for name in "${SKILL_NAMES[@]}"; do
  echo "    $name"
done
echo ""
echo "  Generated skill files: $OUT_DIR/"
echo "  To refresh after updating main skills, run this script again."
