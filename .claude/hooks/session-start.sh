#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web (skip on local CLI installs).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

GSTACK_DIR="$HOME/.claude/skills/gstack"

# 1. Clone gstack if not already present (warm-cache reuse).
if [ ! -d "$GSTACK_DIR" ]; then
  echo "[session-start] cloning gstack..."
  git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$GSTACK_DIR"
fi

# 2. Patch setup to bypass Playwright Chromium download.
#    The web sandbox blocks cdn.playwright.dev (host-allowlist 403),
#    which would otherwise abort setup before skill symlinks are created.
#    Browser-driving skills (/browse, /qa, /design-review, /canary) won't
#    work; methodology skills (/office-hours, /review, /ship, /autoplan,
#    /investigate, /retro, /codex, /cso, /learn, etc.) will.
if ! grep -q 'GSTACK_SKIP_PLAYWRIGHT' "$GSTACK_DIR/setup"; then
  echo "[session-start] patching setup to bypass Playwright (sandbox network restriction)..."
  sed -i '/^ensure_playwright_browser() {$/a\  if [ "${GSTACK_SKIP_PLAYWRIGHT:-0}" = "1" ]; then return 0; fi' "$GSTACK_DIR/setup"
fi

# 3. Run gstack setup with short slash names (--no-prefix gives /office-hours,
#    not /gstack-office-hours). Idempotent — skips rebuild when binaries are current.
echo "[session-start] running gstack setup..."
GSTACK_SKIP_PLAYWRIGHT=1 "$GSTACK_DIR/setup" --no-prefix

# 4. Install this repo's own deps (it's a gstack fork — bun test needs these).
if [ -f "${CLAUDE_PROJECT_DIR:-$PWD}/package.json" ]; then
  echo "[session-start] installing project deps..."
  (cd "${CLAUDE_PROJECT_DIR:-$PWD}" && bun install --silent 2>&1 | tail -5)
fi

SKILL_COUNT=$(find "$HOME/.claude/skills" -mindepth 1 -maxdepth 1 -type d -not -name 'gstack' -not -name 'session-start-hook' | wc -l | tr -d ' ')
echo "[session-start] gstack ready: $SKILL_COUNT slash skills installed"
