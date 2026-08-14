#!/usr/bin/env bash
# test-check-freeze.sh — regression suite for the /freeze PreToolUse hook.
#
# Guards three blocking failures, each of which made the hook silently ineffective:
#   L1 deny protocol   — deny must nest under hookSpecificOutput, or the harness ignores it
#   L2 Windows spawn   — hook command must survive a cmd.exe /d /s /c spawn
#   L3 drive letters   — C:\... / C:/... must compare correctly against a /c/... boundary
# Plus: state-root chain parity with gstack-paths, and no CLAUDE_PLUGIN_DATA
# leakage from a non-gstack plugin.
#
# Runs fully sandboxed: every case gets a throwaway HOME, so a real freeze
# boundary on this machine can neither be read nor written by the tests.
# Usage: bash tests/test-check-freeze.sh    (exit 0 = all green)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../bin/check-freeze.sh"
PASS=0
FAIL=0

if [ ! -f "$HOOK" ]; then
  echo "FATAL: hook script not found at $HOOK"
  exit 1
fi

SANDBOX_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t freeze-test)"
trap 'rm -rf "$SANDBOX_ROOT"' EXIT

ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# run_hook <boundary-or-empty> <file_path> [env assignments...]
# Creates a fresh fake HOME, seeds freeze-dir.txt (unless boundary is ""), and
# pipes a realistic PreToolUse payload through the hook. Echoes stdout.
run_hook() {
  local boundary="$1" file_path="$2"; shift 2
  local home; home="$(mktemp -d "$SANDBOX_ROOT/home.XXXXXX")"
  if [ -n "$boundary" ]; then
    mkdir -p "$home/.gstack"
    printf '%s\n' "$boundary" > "$home/.gstack/freeze-dir.txt"
  fi
  local payload
  payload=$(printf '{"session_id":"test","hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"a","new_string":"b"}}' "$file_path")
  printf '%s' "$payload" | env HOME="$home" GSTACK_HOME= CLAUDE_PLUGIN_DATA= CLAUDE_PLUGIN_ROOT= "$@" bash "$HOOK" 2>/dev/null
}

# assert_deny <case> <output>  — must be a deny the harness will actually honor
assert_deny() {
  local name="$1" out="$2"
  if printf '%s' "$out" | grep -q '"hookSpecificOutput"' \
     && printf '%s' "$out" | grep -q '"hookEventName"[[:space:]]*:[[:space:]]*"PreToolUse"' \
     && printf '%s' "$out" | grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; then
    # and it must be valid JSON with the decision at the nested path
    if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
      local py; py=$(command -v python3 || command -v python)
      if ! printf '%s' "$out" | "$py" -c 'import sys,json; d=json.load(sys.stdin); assert d["hookSpecificOutput"]["permissionDecision"]=="deny"' 2>/dev/null; then
        bad "$name" "deny present but JSON invalid or wrong nesting: $out"; return
      fi
    fi
    ok "$name"
  else
    bad "$name" "expected nested hookSpecificOutput deny, got: ${out:-<empty>}"
  fi
}

assert_allow() {
  local name="$1" out="$2"
  local trimmed; trimmed=$(printf '%s' "$out" | tr -d '[:space:]')
  if [ "$trimmed" = "{}" ]; then ok "$name"
  else bad "$name" "expected {} (no opinion), got: ${out:-<empty>}"; fi
}

echo "== /freeze hook regression =="
echo "hook: $HOOK"
echo

# ── L1: deny protocol ───────────────────────────────────────────────
assert_deny "L1 outside boundary -> nested deny" \
  "$(run_hook "/tmp/frozen/" "/tmp/elsewhere/evil.ts")"

# The exact bug: a top-level permissionDecision is invisible to the harness.
OUT=$(run_hook "/tmp/frozen/" "/tmp/elsewhere/evil.ts")
FIRST_KEY=$(printf '%s' "$OUT" | sed 's/^[[:space:]]*{[[:space:]]*//' | cut -d'"' -f2)
if [ "$FIRST_KEY" = "hookSpecificOutput" ]; then
  ok "L1 deny is not a bare top-level permissionDecision"
else
  bad "L1 deny is not a bare top-level permissionDecision" "top-level key is '$FIRST_KEY' — harness ignores this shape"
fi

assert_allow "L1 inside boundary -> {}" \
  "$(run_hook "/tmp/frozen/" "/tmp/frozen/src/ok.ts")"

# ── L3: Windows drive-letter paths ──────────────────────────────────
assert_deny "L3 C:/ path outside /c/ boundary -> deny" \
  "$(run_hook "/c/repo/frozen/" "C:/repo/other/evil.ts")"

assert_allow "L3 C:/ path inside /c/ boundary -> {}" \
  "$(run_hook "/c/repo/frozen/" "C:/repo/frozen/src/ok.ts")"

# Claude Code sends JSON-escaped backslashes for Windows paths
assert_allow "L3 backslash path inside boundary -> {}" \
  "$(run_hook "/c/repo/frozen/" "C:\\\\repo\\\\frozen\\\\src\\\\ok.ts")"

assert_deny "L3 backslash path outside boundary -> deny" \
  "$(run_hook "/c/repo/frozen/" "C:\\\\repo\\\\other\\\\evil.ts")"

assert_allow "L3 lowercase drive matches uppercase boundary" \
  "$(run_hook "C:/repo/frozen/" "c:/repo/frozen/src/ok.ts")"

# Prefix-collision guard: /src must not match /src-old
assert_deny "L3 sibling prefix (/frozen-old) is outside /frozen" \
  "$(run_hook "/c/repo/frozen/" "C:/repo/frozen-old/evil.ts")"

# ── Fail-open cases (must not block) ────────────────────────────────
assert_allow "no boundary configured -> {}" \
  "$(run_hook "" "/anywhere/x.ts")"

EMPTY_HOME="$(mktemp -d "$SANDBOX_ROOT/home.XXXXXX")"
mkdir -p "$EMPTY_HOME/.gstack"; : > "$EMPTY_HOME/.gstack/freeze-dir.txt"
OUT=$(printf '{"tool_input":{"file_path":"/anywhere/x.ts"}}' | env HOME="$EMPTY_HOME" GSTACK_HOME= CLAUDE_PLUGIN_DATA= CLAUDE_PLUGIN_ROOT= bash "$HOOK" 2>/dev/null)
assert_allow "empty boundary file -> {}" "$OUT"

NP_HOME="$(mktemp -d "$SANDBOX_ROOT/home.XXXXXX")"
mkdir -p "$NP_HOME/.gstack"; printf '/tmp/frozen/\n' > "$NP_HOME/.gstack/freeze-dir.txt"
OUT=$(printf '{"tool_name":"Edit","tool_input":{}}' | env HOME="$NP_HOME" GSTACK_HOME= CLAUDE_PLUGIN_DATA= CLAUDE_PLUGIN_ROOT= bash "$HOOK" 2>/dev/null)
assert_allow "no file_path in payload -> {}" "$OUT"

# ── State-root chain parity with gstack/bin/gstack-paths ────────────
GH="$(mktemp -d "$SANDBOX_ROOT/gstackhome.XXXXXX")"
H2="$(mktemp -d "$SANDBOX_ROOT/home.XXXXXX")"
mkdir -p "$GH"; printf '/tmp/frozen/\n' > "$GH/freeze-dir.txt"
OUT=$(printf '{"tool_input":{"file_path":"/tmp/elsewhere/evil.ts"}}' | env HOME="$H2" GSTACK_HOME="$GH" CLAUDE_PLUGIN_DATA= CLAUDE_PLUGIN_ROOT= bash "$HOOK" 2>/dev/null)
assert_deny "GSTACK_HOME wins over \$HOME/.gstack" "$OUT"

# CLAUDE_PLUGIN_DATA is honored only when CLAUDE_PLUGIN_ROOT says gstack
PD="$(mktemp -d "$SANDBOX_ROOT/plugindata.XXXXXX")"
H3="$(mktemp -d "$SANDBOX_ROOT/home.XXXXXX")"
printf '/tmp/frozen/\n' > "$PD/freeze-dir.txt"
OUT=$(printf '{"tool_input":{"file_path":"/tmp/elsewhere/evil.ts"}}' | env HOME="$H3" GSTACK_HOME= CLAUDE_PLUGIN_DATA="$PD" CLAUDE_PLUGIN_ROOT="/plugins/gstack" bash "$HOOK" 2>/dev/null)
assert_deny "CLAUDE_PLUGIN_DATA honored when PLUGIN_ROOT=gstack" "$OUT"

# ...and ignored when another plugin's data dir leaks into the env
H4="$(mktemp -d "$SANDBOX_ROOT/home.XXXXXX")"
OUT=$(printf '{"tool_input":{"file_path":"/tmp/elsewhere/evil.ts"}}' | env HOME="$H4" GSTACK_HOME= CLAUDE_PLUGIN_DATA="$PD" CLAUDE_PLUGIN_ROOT="/plugins/codex" bash "$HOOK" 2>/dev/null)
assert_allow "foreign CLAUDE_PLUGIN_DATA ignored (no gstack in PLUGIN_ROOT)" "$OUT"

# ── L2: the hook command in SKILL.md must actually spawn ────────────
# Reproduces the harness spawn (cmd.exe /d /s /c "<command>" with verbatim args
# on Windows; sh -c elsewhere) using the command string parsed out of the
# installed SKILL.md — catches a regression to `bash $HOME/...`, which cmd.exe
# leaves unexpanded, and to ${CLAUDE_SKILL_DIR}, which is interpolated only in
# skill body text and never in hook commands.
SKILL_MD=""
for cand in "$HOME/.claude/skills/freeze/SKILL.md" "$SCRIPT_DIR/../SKILL.md"; do
  [ -f "$cand" ] && { SKILL_MD="$cand"; break; }
done

if [ -z "$SKILL_MD" ]; then
  echo "SKIP  L2 spawn contract (no SKILL.md found)"
elif ! command -v node >/dev/null 2>&1; then
  echo "SKIP  L2 spawn contract (node not available)"
else
  HOOK_CMD=$(grep -m1 '^[[:space:]]*command:' "$SKILL_MD" | sed "s/^[[:space:]]*command:[[:space:]]*//; s/^'//; s/'$//")
  if [ -z "$HOOK_CMD" ]; then
    bad "L2 spawn contract" "could not parse a command: line from $SKILL_MD"
  else
    # Sandbox the boundary via GSTACK_HOME, never HOME: the hook command itself
    # resolves the script through $HOME, so a fake HOME would only make bash miss
    # the script and prove nothing. This leaves any real boundary untouched.
    SPAWN_STATE="$(mktemp -d "$SANDBOX_ROOT/spawnstate.XXXXXX")"
    printf '/definitely/frozen/\n' > "$SPAWN_STATE/freeze-dir.txt"
    SPAWN_OUT=$(HOOK_CMD="$HOOK_CMD" SPAWN_STATE="$SPAWN_STATE" node -e '
      const {spawnSync} = require("child_process");
      const cmd = process.env.HOOK_CMD;
      const env = {...process.env, GSTACK_HOME: process.env.SPAWN_STATE};
      delete env.CLAUDE_PLUGIN_DATA; delete env.CLAUDE_PLUGIN_ROOT;
      const win = process.platform === "win32";
      const fire = (fp) => {
        const input = JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Edit",tool_input:{file_path:fp}});
        const r = win
          ? spawnSync(env.comspec || "cmd.exe", ["/d","/s","/c",`"${cmd}"`], {windowsVerbatimArguments:true, input, encoding:"utf8", env})
          : spawnSync("sh", ["-c", cmd], {input, encoding:"utf8", env});
        return {status: r.status, out: (r.stdout||"").trim(), err: (r.stderr||"").trim()};
      };
      // Replicate the harness dispatch rule: only the nested field is acted on.
      const decides = (r) => {
        if (r.status === 2) return "deny";
        let j; try { j = JSON.parse(r.out); } catch { return "allow"; }
        return j?.hookSpecificOutput?.permissionDecision || (j?.decision === "block" ? "deny" : "allow");
      };
      const outside = fire("/definitely/elsewhere/evil.ts");
      const inside  = fire("/definitely/frozen/src/ok.ts");
      process.stdout.write(JSON.stringify({
        spawned: outside.status === 0 && outside.out.startsWith("{"),
        outside: decides(outside), inside: decides(inside), err: outside.err.slice(0,160),
      }));
    ' 2>/dev/null)
    if printf '%s' "$SPAWN_OUT" | grep -q '"spawned":true'; then
      ok "L2 SKILL.md hook command spawns through the harness wrapper"
    else
      bad "L2 SKILL.md hook command spawns through the harness wrapper" "spawn result: $SPAWN_OUT"
    fi
    if printf '%s' "$SPAWN_OUT" | grep -q '"outside":"deny"'; then
      ok "L2 end-to-end: harness would DENY an edit outside the boundary"
    else
      bad "L2 end-to-end: harness would DENY an edit outside the boundary" "spawn result: $SPAWN_OUT"
    fi
    if printf '%s' "$SPAWN_OUT" | grep -q '"inside":"allow"'; then
      ok "L2 end-to-end: harness would ALLOW an edit inside the boundary"
    else
      bad "L2 end-to-end: harness would ALLOW an edit inside the boundary" "spawn result: $SPAWN_OUT"
    fi
  fi
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
