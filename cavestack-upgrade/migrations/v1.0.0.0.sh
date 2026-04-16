#!/usr/bin/env bash
# Migration: v1.0.0.0 — Finished product milestone
#
# What changed:
#   - VERSION bump 0.2.0.0 → 1.0.0.0 (finished product declaration)
#   - New `bin/cavestack-skills` CLI for in-terminal discovery
#   - New `bin/cavestack-dx` for local DX metrics
#   - New `bin/cavestack-cs-aliases` creates `cs-*` short aliases
#   - New `/help` skill for in-Claude-Code discovery
#   - New `lib/error.sh` + `lib/error.ts` Tier-2 error helper
#   - All existing 30+ skills preserved and fully invokable
#
# What this migration does (idempotent):
#   1. Bootstrap ~/.cavestack/analytics/dx-metrics.jsonl (empty file)
#   2. Record install_completed DX event (one-time)
#   3. Run cavestack-cs-aliases to create cs-* shortcuts
#   4. Show "what's new in v1.0" message
#
# What it does NOT do (explicit non-destructive choices):
#   - No skill filesystem moves (keep-all directive from design doc)
#   - No HMAC key generation (receipts dropped from v1.0)
#   - No aggregate counter opt-in prompts (aggregate dropped)
#   - No telemetry or remote data submission
#
# Idempotent — safe to run multiple times.
set -euo pipefail

CAVESTACK_HOME="${CAVESTACK_HOME:-$HOME/.cavestack}"
DX_FILE="$CAVESTACK_HOME/analytics/dx-metrics.jsonl"
MARKER="$CAVESTACK_HOME/.migrations/v1.0.0.0.done"

mkdir -p "$CAVESTACK_HOME/.migrations" "$CAVESTACK_HOME/analytics" 2>/dev/null

# Idempotency check
if [ -f "$MARKER" ]; then
  echo "  [v1.0.0.0] already applied, skipping"
  exit 0
fi

echo "  [v1.0.0.0] CaveStack v1.0 — finished product milestone"

# 1. Bootstrap DX metrics file (empty, local-only)
if [ ! -f "$DX_FILE" ]; then
  touch "$DX_FILE"
  chmod 600 "$DX_FILE" 2>/dev/null || true
fi

# 2. Record install_completed event (idempotent — cavestack-dx handles dedup)
# Resolve cavestack root: migration runs from cavestack-upgrade/migrations/
_mig_dir="$(cd "$(dirname "$0")" && pwd)"
CAVESTACK_ROOT="$(dirname "$(dirname "$_mig_dir")")"
if [ -x "$CAVESTACK_ROOT/bin/cavestack-dx" ]; then
  "$CAVESTACK_ROOT/bin/cavestack-dx" record install_completed "v1.0.0.0" 2>/dev/null || true
fi

# 3. Create cs-* aliases (idempotent — cavestack-cs-aliases skips existing)
if [ -x "$CAVESTACK_ROOT/bin/cavestack-cs-aliases" ]; then
  "$CAVESTACK_ROOT/bin/cavestack-cs-aliases" 2>/dev/null || true
fi

# 4. Write completion marker
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"

# 5. What's new message
cat <<'EOF'

  [v1.0.0.0] Finished product. What's new:

    NEW  cavestack-skills         in-terminal skill catalog
    NEW  /help                    in-Claude-Code skill discovery
    NEW  cavestack-dx             personal DX metrics (local-only)
    NEW  cs-*                     short aliases (cs-skills, cs-config, cs-dx, etc)
    NEW  lib/error.sh + .ts       Tier-2 error pattern for all CLIs

    KEPT all 40+ existing skills — fully invokable by full /name
    KEPT caveman voice — unchanged, still the brand
    KEPT zero telemetry — no remote data, all metrics local

  Try:
    cavestack-skills list         see all skills
    cavestack-dx show             see your DX metrics
    (in Claude Code) /help        in-session discovery

EOF
