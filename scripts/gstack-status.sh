#!/usr/bin/env bash
# Quick status of gstack synthetic memory

GSTACK_DIR=".gstack"

if [ ! -d "$GSTACK_DIR" ]; then
  echo "No .gstack directory found. No active session."
  exit 0
fi

echo "--- gstack Memory Status --------------------"

if [ -f "$GSTACK_DIR/session.json" ]; then
  SKILL=$(grep -o '"skill": *"[^"]*"' "$GSTACK_DIR/session.json" | head -1 | cut -d'"' -f4)
  PHASE=$(grep -o '"phase": *"[^"]*"' "$GSTACK_DIR/session.json" | head -1 | cut -d'"' -f4)
  TURNS=$(grep -o '"turn_count": *[0-9]*' "$GSTACK_DIR/session.json" | head -1 | grep -o '[0-9]*$')
  echo "Skill: /${SKILL:-none} | Phase: ${PHASE:-idle} | Turns: ${TURNS:-0}"
fi

if [ -f "$GSTACK_DIR/findings.md" ]; then
  UNRESOLVED=$(grep -c "Status:\*\* UNRESOLVED" "$GSTACK_DIR/findings.md" 2>/dev/null || echo 0)
  RESOLVED=$(grep -c "Status:\*\* RESOLVED" "$GSTACK_DIR/findings.md" 2>/dev/null || echo 0)
  echo "Findings: $UNRESOLVED unresolved, $RESOLVED resolved"
fi

if [ -f "$GSTACK_DIR/decisions.log" ]; then
  DECISIONS=$(grep -c "DECISION:" "$GSTACK_DIR/decisions.log" 2>/dev/null || echo 0)
  echo "Decisions: $DECISIONS logged"
fi

if [ -f "$GSTACK_DIR/handoff.md" ]; then
  echo "Handoff: present (from previous skill)"
else
  echo "Handoff: none"
fi

CHECKPOINTS=$(ls "$GSTACK_DIR/checkpoints/"checkpoint-*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$CHECKPOINTS" -gt 0 ]; then
  echo "Checkpoints: $CHECKPOINTS saved"
fi

echo "-----------------------------------------------"
