#!/usr/bin/env bash
# Cursor adapter for /careful.
# No-op unless /careful (or /guard) wrote $GSTACK_STATE_ROOT/careful-active.
# Translates Cursor beforeShellExecution JSON into the Claude-shaped payload
# that careful/bin/check-careful.sh already understands, then maps the
# decision back to Cursor's permission object.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAREFUL="$ROOT/careful/bin/check-careful.sh"

INPUT="$(cat)"

# Resolve state dir the same way freeze/careful do.
STATE_DIR="${CLAUDE_PLUGIN_DATA:-${GSTACK_HOME:-$HOME/.gstack}}"
if [ ! -f "$STATE_DIR/careful-active" ]; then
  printf '{"permission":"allow"}\n'
  exit 0
fi

if [ ! -x "$CAREFUL" ] && [ ! -f "$CAREFUL" ]; then
  printf '{"permission":"allow"}\n'
  exit 0
fi

# Cursor beforeShellExecution: { "command": "...", "cwd": "...", "sandbox": false }
# Also accept preToolUse: { "tool_name": "Shell", "tool_input": { "command": "..." } }
PAYLOAD="$INPUT"
if command -v python3 >/dev/null 2>&1; then
  PAYLOAD="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print(raw, end="")
    raise SystemExit(0)
cmd = data.get("command")
if not cmd:
    tool = data.get("tool_input") or {}
    cmd = tool.get("command") or ""
print(json.dumps({"tool_input": {"command": cmd}}))
')"
fi

OUT="$(printf '%s' "$PAYLOAD" | bash "$CAREFUL" 2>/dev/null || true)"
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
    print('{"permission":"allow"}')
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
elif decision == "ask":
    print(json.dumps({
        "permission": "ask",
        "user_message": reason,
        "agent_message": reason,
    }))
else:
    print('{"permission":"allow"}')
PY
