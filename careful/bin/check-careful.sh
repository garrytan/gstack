#!/usr/bin/env bash
# check-careful.sh — PreToolUse hook for /careful skill
# Reads JSON from stdin, checks the Bash command for destructive patterns.
#
# Output contract (verified against cli.js 2.1.92 — the harness dispatches ONLY
# on the nested hookSpecificOutput.permissionDecision field; a bare top-level
# {"permissionDecision":"ask"} parses fine and is then ignored, so the warning
# never appears and the destructive command runs unchallenged):
#   warn  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#             "permissionDecision":"ask","permissionDecisionReason":"..."}}
#   allow -> {}   (no opinion; normal permission flow continues)
# Valid decisions are allow | deny | ask | defer. "ask" prompts the user, who can
# still proceed — this hook warns, it does not block.
#
# Regression: ../tests/test-check-careful.sh. Keep it green.
set -euo pipefail

# Read stdin (JSON with tool_input)
INPUT=$(cat)

# Extract the "command" field value from tool_input
# Try grep/sed first (handles 99% of cases), fall back to Python for escaped quotes
CMD=$(printf '%s' "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//' || true)

# Python fallback if grep returned empty (e.g., escaped quotes in command).
# Try python3 then python: many Windows installs ship only `python`, and if the
# interpreter is missing this silently yields an empty CMD, i.e. a destructive
# command with escaped quotes would sail through unchecked.
if [ -z "$CMD" ]; then
  for _py in python3 python; do
    if command -v "$_py" >/dev/null 2>&1; then
      CMD=$(printf '%s' "$INPUT" | "$_py" -c 'import sys,json; print(json.loads(sys.stdin.read()).get("tool_input",{}).get("command",""))' 2>/dev/null || true)
      if [ -n "$CMD" ]; then break; fi
    fi
  done
fi

# If we still couldn't extract a command, allow
if [ -z "$CMD" ]; then
  echo '{}'
  exit 0
fi

# Normalize: lowercase for case-insensitive SQL matching
CMD_LOWER=$(printf '%s' "$CMD" | tr '[:upper:]' '[:lower:]')

# --- Check for safe exceptions (rm -rf of build artifacts) ---
if printf '%s' "$CMD" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)' 2>/dev/null; then
  SAFE_ONLY=true
  RM_ARGS=$(printf '%s' "$CMD" | sed -E 's/.*rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*//;s/--recursive[[:space:]]*//')
  for target in $RM_ARGS; do
    case "$target" in
      */node_modules|node_modules|*/\.next|\.next|*/dist|dist|*/__pycache__|__pycache__|*/\.cache|\.cache|*/build|build|*/\.turbo|\.turbo|*/coverage|coverage)
        ;; # safe target
      -*)
        ;; # flag, skip
      *)
        SAFE_ONLY=false
        break
        ;;
    esac
  done
  if [ "$SAFE_ONLY" = true ]; then
    echo '{}'
    exit 0
  fi
fi

# --- Destructive pattern checks ---
WARN=""
PATTERN=""

# rm -rf / rm -r / rm --recursive
if printf '%s' "$CMD" | grep -qE 'rm\s+(-[a-zA-Z]*r|--recursive)' 2>/dev/null; then
  WARN="Destructive: recursive delete (rm -r). This permanently removes files."
  PATTERN="rm_recursive"
fi

# DROP TABLE / DROP DATABASE
if [ -z "$WARN" ] && printf '%s' "$CMD_LOWER" | grep -qE 'drop\s+(table|database)' 2>/dev/null; then
  WARN="Destructive: SQL DROP detected. This permanently deletes database objects."
  PATTERN="drop_table"
fi

# TRUNCATE
if [ -z "$WARN" ] && printf '%s' "$CMD_LOWER" | grep -qE '\btruncate\b' 2>/dev/null; then
  WARN="Destructive: SQL TRUNCATE detected. This deletes all rows from a table."
  PATTERN="truncate"
fi

# git push --force / git push -f
if [ -z "$WARN" ] && printf '%s' "$CMD" | grep -qE 'git\s+push\s+.*(-f\b|--force)' 2>/dev/null; then
  WARN="Destructive: git force-push rewrites remote history. Other contributors may lose work."
  PATTERN="git_force_push"
fi

# git reset --hard
if [ -z "$WARN" ] && printf '%s' "$CMD" | grep -qE 'git\s+reset\s+--hard' 2>/dev/null; then
  WARN="Destructive: git reset --hard discards all uncommitted changes."
  PATTERN="git_reset_hard"
fi

# git checkout . / git restore .
if [ -z "$WARN" ] && printf '%s' "$CMD" | grep -qE 'git\s+(checkout|restore)\s+\.' 2>/dev/null; then
  WARN="Destructive: discards all uncommitted changes in the working tree."
  PATTERN="git_discard"
fi

# kubectl delete
if [ -z "$WARN" ] && printf '%s' "$CMD" | grep -qE 'kubectl\s+delete' 2>/dev/null; then
  WARN="Destructive: kubectl delete removes Kubernetes resources. May impact production."
  PATTERN="kubectl_delete"
fi

# docker rm -f / docker system prune
if [ -z "$WARN" ] && printf '%s' "$CMD" | grep -qE 'docker\s+(rm\s+-f|system\s+prune)' 2>/dev/null; then
  WARN="Destructive: Docker force-remove or prune. May delete running containers or cached images."
  PATTERN="docker_destructive"
fi

# --- Output ---
if [ -n "$WARN" ]; then
  # Analytics state root — same chain as gstack/bin/gstack-paths, so the log
  # lands where the rest of gstack looks for it.
  if [ -n "${GSTACK_HOME:-}" ]; then
    STATE_DIR="$GSTACK_HOME"
  elif [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && printf '%s' "${CLAUDE_PLUGIN_ROOT:-}" | grep -qi "gstack"; then
    STATE_DIR="$CLAUDE_PLUGIN_DATA"
  elif [ -n "${HOME:-}" ]; then
    STATE_DIR="$HOME/.gstack"
  else
    STATE_DIR=".gstack"
  fi

  # Log hook fire event (pattern name only, never command content)
  mkdir -p "$STATE_DIR/analytics" 2>/dev/null || true
  echo '{"event":"hook_fire","skill":"careful","pattern":"'"$PATTERN"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}' >> "$STATE_DIR/analytics/skill-usage.jsonl" 2>/dev/null || true

  WARN_ESCAPED=$(printf '%s' "$WARN" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[careful] %s"}}\n' "$WARN_ESCAPED"
else
  echo '{}'
fi
exit 0
