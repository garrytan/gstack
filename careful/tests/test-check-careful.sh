#!/usr/bin/env bash
# test-check-careful.sh — regression suite for the /careful PreToolUse hook.
#
# Guards two failures, each of which made the hook silently ineffective (the same
# pair fixed in /freeze):
#   L1 warn protocol — "ask" must nest under hookSpecificOutput, or the harness
#                      ignores it and the destructive command runs unchallenged
#   L2 Windows spawn — the SKILL.md hook command must survive cmd.exe /d /s /c
# Plus detection coverage: every documented destructive pattern warns, the
# documented safe exceptions do not, and parse failures fail open.
#
# Sandboxed: analytics writes are redirected via GSTACK_HOME, so a real
# ~/.gstack log is never touched.
# Usage: bash tests/test-check-careful.sh    (exit 0 = all green)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../bin/check-careful.sh"
PASS=0
FAIL=0

if [ ! -f "$HOOK" ]; then
  echo "FATAL: hook script not found at $HOOK"
  exit 1
fi

SANDBOX="$(mktemp -d 2>/dev/null || mktemp -d -t careful-test)"
trap 'rm -rf "$SANDBOX"' EXIT

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# run_hook <bash-command-string> — pipes a realistic PreToolUse payload in.
# Uses python to build the JSON so quoting/escaping in the command is faithful.
run_hook() {
  local cmd="$1"
  local payload
  payload=$(CMD="$cmd" python -c 'import json,os; print(json.dumps({"session_id":"test","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":os.environ["CMD"]}}))' 2>/dev/null) \
    || payload=$(printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd")
  printf '%s' "$payload" | env GSTACK_HOME="$SANDBOX/state" CLAUDE_PLUGIN_DATA= CLAUDE_PLUGIN_ROOT= bash "$HOOK" 2>/dev/null
}

# A warn the harness will actually act on: nested, valid JSON, decision "ask".
assert_warn() {
  local name="$1" cmd="$2" out
  out=$(run_hook "$cmd")
  if printf '%s' "$out" | grep -q '"hookSpecificOutput"' \
     && printf '%s' "$out" | grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"ask"'; then
    if printf '%s' "$out" | python -c 'import sys,json; d=json.load(sys.stdin); assert d["hookSpecificOutput"]["permissionDecision"]=="ask"; assert d["hookSpecificOutput"]["hookEventName"]=="PreToolUse"; assert d["hookSpecificOutput"]["permissionDecisionReason"].startswith("[careful]")' 2>/dev/null; then
      ok "$name"
    else
      bad "$name" "ask present but JSON invalid / wrong nesting: $out"
    fi
  else
    bad "$name" "expected nested hookSpecificOutput ask, got: ${out:-<empty>}"
  fi
}

assert_allow() {
  local name="$1" cmd="$2" out trimmed
  out=$(run_hook "$cmd")
  trimmed=$(printf '%s' "$out" | tr -d '[:space:]')
  if [ "$trimmed" = "{}" ]; then ok "$name"
  else bad "$name" "expected {} (no opinion), got: ${out:-<empty>}"; fi
}

echo "== /careful hook regression =="
echo "hook: $HOOK"
echo

# ── L1: warn protocol ───────────────────────────────────────────────
assert_warn "L1 rm -rf warns with nested ask" "rm -rf /var/data"

# The exact bug: a top-level permissionDecision is invisible to the harness.
OUT=$(run_hook "rm -rf /var/data")
FIRST_KEY=$(printf '%s' "$OUT" | sed 's/^[[:space:]]*{[[:space:]]*//' | cut -d'"' -f2)
if [ "$FIRST_KEY" = "hookSpecificOutput" ]; then
  ok "L1 warn is not a bare top-level permissionDecision"
else
  bad "L1 warn is not a bare top-level permissionDecision" "top-level key is '$FIRST_KEY' — harness ignores this shape"
fi

# ── Detection coverage: every documented pattern ────────────────────
assert_warn "detect rm -r"              "rm -r /important"
assert_warn "detect DROP TABLE"         "psql -c 'DROP TABLE users;'"
assert_warn "detect DROP DATABASE"      "mysql -e 'drop database prod;'"
assert_warn "detect TRUNCATE"           "psql -c 'TRUNCATE orders;'"
assert_warn "detect git push --force"   "git push --force origin main"
assert_warn "detect git push -f"        "git push -f origin main"
assert_warn "detect git reset --hard"   "git reset --hard HEAD~3"
assert_warn "detect git checkout ."     "git checkout ."
assert_warn "detect git restore ."      "git restore ."
assert_warn "detect kubectl delete"     "kubectl delete pod api-7f9"
assert_warn "detect docker rm -f"       "docker rm -f my-container"
assert_warn "detect docker system prune" "docker system prune -a"

# ── Safe exceptions must NOT warn ───────────────────────────────────
assert_allow "safe: rm -rf node_modules"      "rm -rf node_modules"
assert_allow "safe: rm -rf ./dist"            "rm -rf ./dist"
assert_allow "safe: rm -rf .next"             "rm -rf .next"
assert_allow "safe: rm -rf build coverage"    "rm -rf build coverage"

# ── Benign commands must NOT warn ───────────────────────────────────
assert_allow "benign: ls"                     "ls -la"
assert_allow "benign: git status"             "git status"
assert_allow "benign: git push (no force)"    "git push origin feature-branch"
assert_allow "benign: npm test"               "npm test"

# ── Fail-open: unparseable / absent input must not warn ─────────────
OUT=$(printf '{"tool_name":"Bash","tool_input":{}}' | env GSTACK_HOME="$SANDBOX/state" bash "$HOOK" 2>/dev/null)
TRIM=$(printf '%s' "$OUT" | tr -d '[:space:]')
if [ "$TRIM" = "{}" ]; then ok "no command in payload -> {}"
else bad "no command in payload -> {}" "got: ${OUT:-<empty>}"; fi

# ── Analytics must not escape the sandbox ───────────────────────────
run_hook "rm -rf /var/data" >/dev/null
if [ -f "$SANDBOX/state/analytics/skill-usage.jsonl" ]; then
  ok "analytics honors GSTACK_HOME (no write to real ~/.gstack)"
else
  bad "analytics honors GSTACK_HOME (no write to real ~/.gstack)" "expected $SANDBOX/state/analytics/skill-usage.jsonl"
fi

# ── L2: the hook command in SKILL.md must actually spawn ────────────
SKILL_MD=""
for cand in "$HOME/.claude/skills/careful/SKILL.md" "$SCRIPT_DIR/../SKILL.md"; do
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
    SPAWN_OUT=$(HOOK_CMD="$HOOK_CMD" SPAWN_STATE="$SANDBOX/spawnstate" node -e '
      const {spawnSync} = require("child_process");
      const cmd = process.env.HOOK_CMD;
      const env = {...process.env, GSTACK_HOME: process.env.SPAWN_STATE};
      delete env.CLAUDE_PLUGIN_DATA; delete env.CLAUDE_PLUGIN_ROOT;
      const win = process.platform === "win32";
      const fire = (command) => {
        const input = JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command}});
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
      const destructive = fire("rm -rf /var/data");
      const benign = fire("ls -la");
      process.stdout.write(JSON.stringify({
        spawned: destructive.status === 0 && destructive.out.startsWith("{"),
        destructive: decides(destructive), benign: decides(benign), err: destructive.err.slice(0,160),
      }));
    ' 2>/dev/null)
    if printf '%s' "$SPAWN_OUT" | grep -q '"spawned":true'; then
      ok "L2 SKILL.md hook command spawns through the harness wrapper"
    else
      bad "L2 SKILL.md hook command spawns through the harness wrapper" "spawn result: $SPAWN_OUT"
    fi
    if printf '%s' "$SPAWN_OUT" | grep -q '"destructive":"ask"'; then
      ok "L2 end-to-end: harness would PROMPT on a destructive command"
    else
      bad "L2 end-to-end: harness would PROMPT on a destructive command" "spawn result: $SPAWN_OUT"
    fi
    if printf '%s' "$SPAWN_OUT" | grep -q '"benign":"allow"'; then
      ok "L2 end-to-end: harness would NOT prompt on a benign command"
    else
      bad "L2 end-to-end: harness would NOT prompt on a benign command" "spawn result: $SPAWN_OUT"
    fi
  fi
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
