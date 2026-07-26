#!/usr/bin/env bash
# check-freeze.sh — PreToolUse hook for /freeze skill
# Reads hook JSON from stdin, checks whether tool_input.file_path falls inside
# the freeze boundary stored in $STATE_DIR/freeze-dir.txt.
#
# Output contract (verified against cli.js 2.1.92 — the harness dispatches
# ONLY on the nested hookSpecificOutput.permissionDecision field; a bare
# top-level {"permissionDecision":"deny"} is silently ignored, which was
# layer 1 of the 2026-07-26 three-layer blocking failure):
#   allow -> {}   (exit 0: no opinion, normal permission flow continues)
#   deny  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#             "permissionDecision":"deny","permissionDecisionReason":"..."}}
#            (exit 0; exit code 2 + stderr is the legacy alternative, unused here)
#
# Regression: ../tests/test-check-freeze.sh (sandboxed fake HOME; deny/allow
# schema, drive-letter paths, state-root chain). Keep it green.
set -euo pipefail

INPUT=$(cat)

# State root — keep in sync with gstack/bin/gstack-paths:
#   GSTACK_HOME
#   -> CLAUDE_PLUGIN_DATA (only when CLAUDE_PLUGIN_ROOT confirms *gstack*, so
#      another plugin's CLAUDE_PLUGIN_DATA leaking into the session env cannot
#      redirect where freeze state is read from)
#   -> $HOME/.gstack
#   -> .gstack
if [ -n "${GSTACK_HOME:-}" ]; then
  STATE_DIR="$GSTACK_HOME"
elif [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && printf '%s' "${CLAUDE_PLUGIN_ROOT:-}" | grep -qi "gstack"; then
  STATE_DIR="$CLAUDE_PLUGIN_DATA"
elif [ -n "${HOME:-}" ]; then
  STATE_DIR="$HOME/.gstack"
else
  STATE_DIR=".gstack"
fi
FREEZE_FILE="$STATE_DIR/freeze-dir.txt"

# If no freeze file exists, allow everything (not yet configured)
if [ ! -f "$FREEZE_FILE" ]; then
  echo '{}'
  exit 0
fi

FREEZE_DIR=$(tr -d '[:space:]' < "$FREEZE_FILE")

# If freeze dir is empty, allow
if [ -z "$FREEZE_DIR" ]; then
  echo '{}'
  exit 0
fi

# Extract file_path from tool_input JSON.
# grep/sed fast path first; note it yields JSON-escaped content (C:\\Users\\...)
# which _to_posix below flattens. The python fallback yields the decoded form.
FILE_PATH=$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//' || true)

if [ -z "$FILE_PATH" ]; then
  for _py in python3 python; do
    if command -v "$_py" >/dev/null 2>&1; then
      FILE_PATH=$(printf '%s' "$INPUT" | "$_py" -c 'import sys,json; print(json.loads(sys.stdin.read()).get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)
      if [ -n "$FILE_PATH" ]; then break; fi
    fi
  done
fi

# If we couldn't extract a file path, allow (don't block on parse failure)
if [ -z "$FILE_PATH" ]; then
  echo '{}'
  exit 0
fi

# Canonicalize to POSIX form. Claude Code on Windows passes drive-letter
# file paths (C:\foo or C:/foo) while the boundary file stores the Git-Bash
# pwd form (/c/foo) written at setup time. Without this the two sides can
# never prefix-match, and the old relative-path fallback glued $(pwd) onto a
# drive-letter path (layer 3 of the 2026-07-26 failure).
_to_posix() {
  local p="$1"
  p=${p//\\//}                    # backslashes (incl. JSON-escaped \\) -> /
  case "$p" in
    [A-Za-z]:/*|[A-Za-z]:)        # C:/foo -> /c/foo
      local _drive="${p%%:*}"
      _drive=$(printf '%s' "$_drive" | tr '[:upper:]' '[:lower:]')
      p="/${_drive}${p#?:}"
      ;;
  esac
  printf '%s' "$p"
}
FILE_PATH=$(_to_posix "$FILE_PATH")
FREEZE_DIR=$(_to_posix "$FREEZE_DIR")

# Resolve file_path to absolute if it isn't already (drive-letter forms were
# rewritten to /c/... above, so they correctly take the absolute branch)
case "$FILE_PATH" in
  /*) ;;
  *)
    FILE_PATH="$(pwd)/$FILE_PATH"
    ;;
esac

# Normalize: remove double slashes and trailing slash
FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's|/\+|/|g;s|/$||')

# Resolve symlinks and .. sequences (POSIX-portable, works on macOS)
_resolve_path() {
  local _dir _base
  _dir="$(dirname "$1")"
  _base="$(basename "$1")"
  _dir="$(cd "$_dir" 2>/dev/null && pwd -P || printf '%s' "$_dir")"
  printf '%s/%s' "$_dir" "$_base"
}
FILE_PATH=$(_resolve_path "$FILE_PATH")
FREEZE_DIR=$(_resolve_path "$FREEZE_DIR")

# Minimal JSON string escaping for interpolated paths (backslashes are gone
# after _to_posix; embedded double quotes are the remaining hazard)
_json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Check: does the file path start with the freeze directory?
case "$FILE_PATH" in
  "${FREEZE_DIR}/"*|"${FREEZE_DIR}")
    # Inside freeze boundary — allow
    echo '{}'
    ;;
  *)
    # Outside freeze boundary — deny via the schema the harness dispatches on
    mkdir -p "$STATE_DIR/analytics" 2>/dev/null || true
    echo '{"event":"hook_fire","skill":"freeze","pattern":"boundary_deny","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}' >> "$STATE_DIR/analytics/skill-usage.jsonl" 2>/dev/null || true

    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[freeze] Blocked: %s is outside the freeze boundary (%s). Only edits within the frozen directory are allowed. Run /unfreeze to lift the boundary."}}\n' "$(_json_escape "$FILE_PATH")" "$(_json_escape "$FREEZE_DIR")"
    ;;
esac
exit 0
