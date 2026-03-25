#!/usr/bin/env bash
# Initialize gstack synthetic memory directories
# Session state → ~/.gstack/projects/$SLUG/ (private, per-user)
# Team knowledge → .gstack/ (repo-level, optionally committed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Get project slug and branch (check PATH first, then relative to script)
if command -v gstack-slug &>/dev/null; then
  eval "$(gstack-slug 2>/dev/null)" || { SLUG="unknown"; BRANCH="unknown"; }
elif [ -x "$SCRIPT_DIR/../bin/gstack-slug" ]; then
  eval "$("$SCRIPT_DIR/../bin/gstack-slug" 2>/dev/null)" || { SLUG="unknown"; BRANCH="unknown"; }
else
  SLUG="unknown"
  BRANCH="unknown"
fi

GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
SESSION_DIR="$GSTACK_HOME/projects/$SLUG"

# --- Session state (private, per-user) ---
mkdir -p "$SESSION_DIR"

if [ ! -f "$SESSION_DIR/state.md" ]; then
  cat > "$SESSION_DIR/state.md" << 'EOF'
skill: null
phase: idle
turn: 0
started: null
EOF
fi

if [ ! -f "$SESSION_DIR/findings-$BRANCH.md" ]; then
  cat > "$SESSION_DIR/findings-$BRANCH.md" << EOF
# Findings Registry — $BRANCH

> Auto-maintained by gstack skills. Each finding is written here immediately
> upon discovery. This file is the source of truth — not conversation history.

---

EOF
fi

# --- Team knowledge (repo-level, optionally committed) ---
mkdir -p .gstack

if [ ! -f .gstack/decisions.log ]; then
  touch .gstack/decisions.log
fi

if [ ! -f .gstack/anti-patterns.md ]; then
  cat > .gstack/anti-patterns.md << 'EOF'
# Anti-Patterns Registry

> Failed fix attempts that should never be re-tried. Search this file before
> attempting any fix in /investigate.

---

EOF
fi

echo "gstack memory initialized (session: $SESSION_DIR, team: .gstack/)"
