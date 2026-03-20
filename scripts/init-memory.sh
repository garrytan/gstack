#!/usr/bin/env bash
# Initialize .gstack synthetic memory directory
# Called by skills before first use

GSTACK_DIR=".gstack"

mkdir -p "$GSTACK_DIR/checkpoints"

# Initialize session.json if it doesn't exist
if [ ! -f "$GSTACK_DIR/session.json" ]; then
  cat > "$GSTACK_DIR/session.json" << 'EOF'
{
  "skill": null,
  "started_at": null,
  "phase": "idle",
  "turn_count": 0,
  "critical_findings": [],
  "decisions": [],
  "completed_checks": [],
  "pending_checks": [],
  "context_warnings": []
}
EOF
fi

# Initialize findings.md if it doesn't exist
if [ ! -f "$GSTACK_DIR/findings.md" ]; then
  cat > "$GSTACK_DIR/findings.md" << 'EOF'
# Findings Registry

> Auto-maintained by gstack skills. Each finding is written here immediately
> upon discovery. This file is the source of truth — not conversation history.

---

EOF
fi

# Initialize decisions.log if it doesn't exist
if [ ! -f "$GSTACK_DIR/decisions.log" ]; then
  touch "$GSTACK_DIR/decisions.log"
fi

echo "gstack memory initialized at $GSTACK_DIR"
