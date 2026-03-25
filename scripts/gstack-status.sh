#!/usr/bin/env bash
# Display gstack synthetic memory status (both session and team layers)

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

echo "=== gstack Memory Status ==="
echo "Project: $SLUG"
echo "Branch:  $BRANCH"
echo ""

# --- Session state ---
echo "--- Session (private) ---"
if [ -f "$SESSION_DIR/state.md" ]; then
  cat "$SESSION_DIR/state.md"
else
  echo "No active session"
fi
echo ""

FINDINGS_FILE="$SESSION_DIR/findings-$BRANCH.md"
if [ -f "$FINDINGS_FILE" ]; then
  TOTAL=$(grep -c "^### F" "$FINDINGS_FILE" 2>/dev/null || echo "0")
  UNRESOLVED=$(grep -c "Status:\*\* UNRESOLVED" "$FINDINGS_FILE" 2>/dev/null || echo "0")
  RESOLVED=$(grep -c "Status:\*\* RESOLVED" "$FINDINGS_FILE" 2>/dev/null || echo "0")
  echo "Findings ($BRANCH): $TOTAL total ($UNRESOLVED unresolved, $RESOLVED resolved)"
else
  echo "Findings ($BRANCH): none"
fi

if [ -f "$SESSION_DIR/handoff.md" ]; then
  echo "Handoff: present (from previous skill)"
else
  echo "Handoff: none"
fi
echo ""

# --- Team knowledge ---
echo "--- Team Knowledge (repo) ---"
if [ -f .gstack/decisions.log ]; then
  DECISIONS=$(wc -l < .gstack/decisions.log | tr -d ' ')
  echo "Decisions: $DECISIONS lines logged"
else
  echo "Decisions: none"
fi

if [ -f .gstack/anti-patterns.md ]; then
  AP_COUNT=$(grep -c "^### AP" .gstack/anti-patterns.md 2>/dev/null || echo "0")
  echo "Anti-patterns: $AP_COUNT recorded"
else
  echo "Anti-patterns: none"
fi
