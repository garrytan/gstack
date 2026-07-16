#!/usr/bin/env bash
# Migration: v1.37.0.0 — split-engine gbrain (remote MCP brain + optional
#   local PGLite for code search per worktree).
#
# Per plan D5: prints a ONE-TIME discoverability notice for existing
# Path 4 users who don't yet have a local engine. They learn that
# symbol-aware code search (gbrain code-def / code-refs / code-callers)
# is now available via /setup-gbrain Step 4.5 if they want it.
#
# When to print the notice (state match — all conditions must hold):
#   - ~/.claude.json declares mcpServers.gbrain.{type|transport} = http|sse|url
#     OR mcpServers.gbrain.url is set (remote-http MCP active)
#   - ~/.gbrain/config.json is absent (no local engine yet)
#   - User has not previously opted out via:
#       ~/.claude/skills/gstack/bin/gstack-config set local_code_index_offered true
#
# When silent: anything else (Path 1/2/3 users, anyone already on PGLite,
# anyone who opted out, anyone without remote-http MCP).
#
# Idempotency: writes a touchfile at ~/.gstack/.migrations/v1.37.0.0.done
# on completion. Re-running this script is silent if the touchfile exists,
# OR if local_code_index_offered=true.

set -euo pipefail

if [ -z "${HOME:-}" ]; then
  echo "  [v1.37.0.0] HOME is unset — skipping migration." >&2
  exit 0
fi

GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
MIGRATIONS_DIR="$GSTACK_HOME/.migrations"
DONE_TOUCH="$MIGRATIONS_DIR/v1.37.0.0.done"
CONFIG_BIN="$HOME/.claude/skills/gstack/bin/gstack-config"
CLAUDE_JSON="$HOME/.claude.json"
GBRAIN_CONFIG="$HOME/.gbrain/config.json"

mkdir -p "$MIGRATIONS_DIR"

# Idempotency: already-ran skips silently.
if [ -f "$DONE_TOUCH" ]; then
  exit 0
fi

# User opt-out skips silently AND records done.
if [ -x "$CONFIG_BIN" ]; then
  if [ "$("$CONFIG_BIN" get local_code_index_offered 2>/dev/null)" = "true" ]; then
    touch "$DONE_TOUCH"
    exit 0
  fi
fi

# State match: remote-http MCP active?
is_remote_http_mcp() {
  [ -f "$CLAUDE_JSON" ] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  local mtype murl
  mtype=$(jq -r '.mcpServers.gbrain.type // .mcpServers.gbrain.transport // empty' "$CLAUDE_JSON" 2>/dev/null)
  murl=$(jq -r '.mcpServers.gbrain.url // empty' "$CLAUDE_JSON" 2>/dev/null)
  case "$mtype" in
    url|http|sse) return 0 ;;
  esac
  [ -n "$murl" ] && return 0
  return 1
}

# State match: local engine absent?
is_local_engine_missing() {
  [ ! -f "$GBRAIN_CONFIG" ]
}

if is_remote_http_mcp && is_local_engine_missing; then
  cat <<'NOTICE'

  ┌──────────────────────────────────────────────────────────────────┐
  │  gstack v1.37.0.0 — split-engine gbrain                          │
  │                                                                  │
  │  Symbol-aware code search is now available on this machine.      │
  │  Your remote brain at gbrain MCP keeps working as today; you can │
  │  add a tiny local PGLite (~30s, no accounts) for `gbrain         │
  │  code-def` / `code-refs` / `code-callers` queries per worktree.  │
  │                                                                  │
  │  Run /setup-gbrain to opt in at Step 4.5. Or skip this notice    │
  │  permanently:                                                    │
  │    gstack-config set local_code_index_offered true               │
  └──────────────────────────────────────────────────────────────────┘

NOTICE
fi

# Always touch done so we don't print again, regardless of state-match outcome.
touch "$DONE_TOUCH"
