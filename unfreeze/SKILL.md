---
name: unfreeze
version: 0.1.0
description: |
  Clear freeze boundary from /freeze, re-allow edits to all directories.
  Use when asked to "unfreeze", "unlock edits", "remove freeze", or
  "allow all edits". (cavestack)
allowed-tools:
  - Bash
  - Read
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /unfreeze — Clear Freeze Boundary

Remove edit restriction from `/freeze`. Edits allowed everywhere again.

```bash
mkdir -p ~/.cavestack/analytics
echo '{"skill":"unfreeze","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.cavestack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## Clear the boundary

```bash
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.cavestack}"
if [ -f "$STATE_DIR/freeze-dir.txt" ]; then
  PREV=$(cat "$STATE_DIR/freeze-dir.txt")
  rm -f "$STATE_DIR/freeze-dir.txt"
  echo "Freeze boundary cleared (was: $PREV). Edits are now allowed everywhere."
else
  echo "No freeze boundary was set."
fi
```

Tell user result. `/freeze` hooks still registered for session but allow everything since no state file exists. Re-freeze: run `/freeze` again.
