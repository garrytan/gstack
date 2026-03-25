#!/usr/bin/env bash
# Reset gstack synthetic memory (archive session state, preserve team knowledge)

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

if [ ! -d "$SESSION_DIR" ]; then
  echo "No session state found for $SLUG. Nothing to reset."
  exit 0
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$SESSION_DIR/archive-$TIMESTAMP"
mkdir -p "$ARCHIVE"

# Archive session state (private)
[ -f "$SESSION_DIR/state.md" ] && cp "$SESSION_DIR/state.md" "$ARCHIVE/"
[ -f "$SESSION_DIR/findings-$BRANCH.md" ] && cp "$SESSION_DIR/findings-$BRANCH.md" "$ARCHIVE/"
[ -f "$SESSION_DIR/handoff.md" ] && cp "$SESSION_DIR/handoff.md" "$ARCHIVE/"

echo "Archived session state to $ARCHIVE"

# Reset session state only — team knowledge (.gstack/decisions.log, anti-patterns.md) is preserved
rm -f "$SESSION_DIR/state.md" "$SESSION_DIR/findings-$BRANCH.md" "$SESSION_DIR/handoff.md"
bash "$SCRIPT_DIR/init-memory.sh"

echo "Session reset complete. Team knowledge (.gstack/) preserved."
