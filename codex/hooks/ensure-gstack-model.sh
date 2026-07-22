#!/usr/bin/env bash
# Compatibility path; read-only and advisory. Invocation preflight is blocking.
set -euo pipefail
HEALTH="${CODEX_HOME:-$HOME/.codex}/skills/gstack/bin/gstack-codex-runtime-health"
[ -x "$HEALTH" ] || { echo "gstack runtime absent; run setup --host codex and restart Codex" >&2; exit 1; }
exec "$HEALTH" --quiet
