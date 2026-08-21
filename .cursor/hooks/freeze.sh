#!/usr/bin/env bash
# Cursor adapter for /freeze.
# No-op unless /freeze (or /guard) wrote freeze-dir.txt.
# Translates Cursor Write/StrReplace payloads into the Claude-shaped
# { tool_input: { file_path } } that freeze/bin/check-freeze.sh expects.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FREEZE="$ROOT/freeze/bin/check-freeze.sh"

INPUT="$(cat)"

STATE_DIR="${CLAUDE_PLUGIN_DATA:-${GSTACK_HOME:-$HOME/.gstack}}"
if [ ! -f "$STATE_DIR/freeze-dir.txt" ]; then
  printf '{"permission":"allow"}\n'
  exit 0
fi

if [ ! -f "$FREEZE" ]; then
  printf '{"permission":"deny","user_message":"[freeze] freeze checker missing","agent_message":"[freeze] freeze checker missing — blocked fail-closed. Run /unfreeze or reinstall gstack."}\n'
  exit 0
fi

PAYLOAD="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print(json.dumps({"tool_input": {}}))
    raise SystemExit(0)
tool = data.get("tool_input") or {}
path = (
    tool.get("file_path")
    or tool.get("path")
    or tool.get("target_notebook")
    or data.get("file_path")
    or data.get("path")
    or ""
)
print(json.dumps({"tool_input": {"file_path": path}}))
')"

OUT="$(printf '%s' "$PAYLOAD" | bash "$FREEZE" 2>/dev/null || true)"
if [ -z "$OUT" ] || [ "$OUT" = "{}" ]; then
  printf '{"permission":"allow"}\n'
  exit 0
fi

python3 - <<'PY' "$OUT"
import json, sys
raw = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    data = json.loads(raw)
except Exception:
    print('{"permission":"deny","user_message":"[freeze] could not parse freeze checker output","agent_message":"[freeze] could not parse freeze checker output — blocked fail-closed."}')
    raise SystemExit(0)
inner = data.get("hookSpecificOutput") or {}
decision = inner.get("permissionDecision") or data.get("permissionDecision") or "allow"
reason = inner.get("permissionDecisionReason") or data.get("permissionDecisionReason") or ""
if decision == "deny":
    print(json.dumps({
        "permission": "deny",
        "user_message": reason,
        "agent_message": reason,
    }))
else:
    print('{"permission":"allow"}')
PY
