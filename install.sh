#!/usr/bin/env bash
# gstack installer — curl-pipe-bash one-liner
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/garrytan/gstack/main/install.sh)
#
set -euo pipefail

INSTALL_DIR="$HOME/.claude/skills/gstack"

echo "gstack installer"
echo "━━━━━━━━━━━━━━━━"
echo ""

# ─── Check prereqs ────────────────────────────────────────────
for cmd in git bun; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is required but not found."
    case "$cmd" in
      git) echo "  Install: https://git-scm.com/downloads" ;;
      bun) echo "  Install: curl -fsSL https://bun.sh/install | bash" ;;
    esac
    exit 1
  fi
done

# Claude CLI check (warn, don't fail — they might install it after)
if ! command -v claude >/dev/null 2>&1; then
  echo "Warning: Claude CLI not found."
  echo "  Install: npm install -g @anthropic-ai/claude-code"
  echo "  (gstack requires Claude Code to run skills)"
  echo ""
fi

# ─── Fresh install vs upgrade ─────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "gstack already installed — upgrading..."
  cd "$INSTALL_DIR" && git pull origin main && ./setup
else
  echo "Installing gstack to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone https://github.com/garrytan/gstack.git "$INSTALL_DIR"
  cd "$INSTALL_DIR" && ./setup
fi

echo ""
echo "Note: gstack checks for updates by pinging our server with your"
echo "version number, OS, and a random device ID. No usage data is sent."
echo ""
echo "gstack installed! Try: /office-hours"
