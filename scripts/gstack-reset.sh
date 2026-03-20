#!/usr/bin/env bash
# Reset gstack synthetic memory (archive current state first)

GSTACK_DIR=".gstack"

if [ ! -d "$GSTACK_DIR" ]; then
  echo "No .gstack directory found. Nothing to reset."
  exit 0
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$GSTACK_DIR/checkpoints/archive-$TIMESTAMP"
mkdir -p "$ARCHIVE"

# Archive current state
[ -f "$GSTACK_DIR/session.json" ] && cp "$GSTACK_DIR/session.json" "$ARCHIVE/"
[ -f "$GSTACK_DIR/findings.md" ] && cp "$GSTACK_DIR/findings.md" "$ARCHIVE/"
[ -f "$GSTACK_DIR/decisions.log" ] && cp "$GSTACK_DIR/decisions.log" "$ARCHIVE/"
[ -f "$GSTACK_DIR/handoff.md" ] && cp "$GSTACK_DIR/handoff.md" "$ARCHIVE/"

echo "Archived current state to $ARCHIVE"

# Reset
rm -f "$GSTACK_DIR/session.json" "$GSTACK_DIR/findings.md" "$GSTACK_DIR/decisions.log" "$GSTACK_DIR/handoff.md"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$SCRIPT_DIR/init-memory.sh"

echo "Memory reset complete. Previous state archived."
