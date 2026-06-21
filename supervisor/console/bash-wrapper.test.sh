#!/usr/bin/env bash
# supervisor/console/bash-wrapper.test.sh
# Tests: REAL_BASH detection, chain-risk splitting, jq-free decision parsing,
# and SUPERVISOR_DECISIONS_DIR guard.
# Run standalone: bash supervisor/console/bash-wrapper.test.sh
# Run via bun:    bun test supervisor/console/ (invoked by bash-wrapper.test.ts)

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$THIS_DIR/bin/bash"

pass=0
fail=0

_ok()   { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
_fail() { printf '  FAIL  %s\n' "$1" >&2; fail=$((fail + 1)); }

# Minimal safe PATH: python3 + real bash only.  Excludes supervisor wrappers so
# REAL_BASH inside the wrapper always resolves to the system bash, not another
# wrapper.  Also prevents shebang-loop E2BIG when multiple wrappers are on PATH.
_SAFE_PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

# Invoke the wrapper using an explicit /bin/bash interpreter (bypasses PATH-based
# shebang resolution and prevents infinite wrapper→shebang→wrapper loops).
# Passes a clean, minimal environment so nothing leaks from the agent shell.
# Callers prepend extra VAR=value pairs before the wrapper path:
#   _wrap_run VAR=val "$WRAPPER" -c 'cmd'
_wrap_run() {
  env -i \
    HOME="$HOME" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PATH="$_SAFE_PATH" \
    "$@"
}

# Inline copies of check_risk and evaluate_chain_risk from bin/bash.
# These must stay in sync with the wrapper implementation.
check_risk() {
  local cmd="$1"
  if echo "$cmd" | grep -qE \
    'git[[:space:]]+push|git[[:space:]]+rebase[[:space:]]|git[[:space:]]+reset[[:space:]]|rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|curl[^|]*\|[[:space:]]*(bash|sh)|wget[^|]*\|[[:space:]]*(bash|sh)|chmod[[:space:]]+-R|chown[[:space:]]+-R|dd[[:space:]]+if=|mkfs|fdisk'; then
    echo "high"
  else
    echo "low"
  fi
}

evaluate_chain_risk() {
  local full_cmd="$1"
  local segments
  segments=$(python3 -c "
import re, sys
parts = re.split(r'&&|\|\||;', sys.argv[1])
for p in parts:
    s = p.strip()
    if s:
        print(s)
" "$full_cmd" 2>/dev/null) || segments="$full_cmd"
  while IFS= read -r seg; do
    [ -z "$seg" ] && continue
    if [ "$(check_risk "$seg")" = "high" ]; then
      echo "high"
      return
    fi
  done <<< "$segments"
  echo "low"
}

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "=== AC1: REAL_BASH resolution via symlink ==="

# Create a fake bin dir with only a symlink named "bash" pointing to our wrapper.
# The symlink appears first in PATH so "type -ap bash" finds it; the wrapper must
# skip it via the realpath self-exclusion and pick the system bash instead.
# We call via /bin/bash (not PATH lookup) to avoid the shebang-loop E2BIG.
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
ln -s "$WRAPPER" "$FAKEBIN/bash"

_wrap_run PATH="$FAKEBIN:$_SAFE_PATH" /bin/bash "$FAKEBIN/bash" -c 'exit 0'
C_AC1=$?
[ "$C_AC1" -eq 0 ] \
  && _ok "symlinked wrapper resolves REAL_BASH to system bash (exit 0)" \
  || _fail "symlinked wrapper resolves REAL_BASH to system bash (got exit $C_AC1)"

echo ""
echo "=== AC2: check_risk / chain classification ==="

[ "$(check_risk 'git push origin main')" = "high" ] \
  && _ok "git push origin main → high" \
  || _fail "git push origin main → high"

[ "$(check_risk 'git commit -m "fix"')" != "high" ] \
  && _ok 'git commit -m "fix" → not high' \
  || _fail 'git commit -m "fix" → not high'

[ "$(check_risk 'bun test')" = "low" ] \
  && _ok "bun test → low" \
  || _fail "bun test → low"

[ "$(evaluate_chain_risk 'cd /tmp && git push origin main')" = "high" ] \
  && _ok "cd /tmp && git push origin main → high (chained)" \
  || _fail "cd /tmp && git push origin main → high (chained)"

[ "$(check_risk 'rm -rf /home')" = "high" ] \
  && _ok "rm -rf /home → high" \
  || _fail "rm -rf /home → high"

echo ""
echo "=== AC3: poll_approval (python3 JSON parsing, no jq) ==="

# Wait up to 5s for a request file to appear in dir $1; print its path.
_wait_req() {
  local dir="$1" req=""
  for _i in 1 2 3 4 5; do
    req=$(ls "$dir"/*.json 2>/dev/null | grep -v '\.decision\.json' | head -1)
    [ -n "$req" ] && echo "$req" && return 0
    sleep 1
  done
  return 1
}

# Write a decision file for the request in $1 with approved=$2 into dir $3.
_write_decision() {
  local req_file="$1" approved="$2" dir="$3"
  local agent rid
  agent=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['agent'])" "$req_file" 2>/dev/null) || return 1
  rid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['request_id'])" "$req_file" 2>/dev/null) || return 1
  printf '{"approved": %s}\n' "$approved" > "$dir/${agent}-${rid}.decision.json"
}

# Mock git so approved commands always succeed (tests wrapper behaviour, not real git).
MOCKBIN="$WORK/mockbin"
mkdir -p "$MOCKBIN"
printf '#!/usr/bin/env bash\nexit 0\n' > "$MOCKBIN/git"
chmod +x "$MOCKBIN/git"

# AC3a: approved:true → exit 0.
DECDIR="$WORK/decisions_a"
mkdir -p "$DECDIR"
_wrap_run \
  PATH="$MOCKBIN:$_SAFE_PATH" \
  SUPERVISOR_DECISIONS_DIR="$DECDIR" \
  AGENT_NAME=test_agent \
  /bin/bash "$WRAPPER" -c 'git push origin main' &
W3A=$!
REQ=$(_wait_req "$DECDIR") && _write_decision "$REQ" "true" "$DECDIR"
wait "$W3A"; C3A=$?
[ "$C3A" -eq 0 ] \
  && _ok "approved → exit 0 (python3 JSON parsing)" \
  || _fail "approved → exit 0 (got exit $C3A)"

# AC3b: approved:false → exit 1.
DECDIR="$WORK/decisions_b"
mkdir -p "$DECDIR"
_wrap_run \
  SUPERVISOR_DECISIONS_DIR="$DECDIR" \
  AGENT_NAME=test_agent \
  /bin/bash "$WRAPPER" -c 'git push origin main' &
W3B=$!
REQ=$(_wait_req "$DECDIR") && _write_decision "$REQ" "false" "$DECDIR"
wait "$W3B"; C3B=$?
[ "$C3B" -eq 1 ] \
  && _ok "rejected → exit 1" \
  || _fail "rejected → exit 1 (got exit $C3B)"

# AC3c: no decision within timeout → non-zero exit.
DECDIR="$WORK/decisions_c"
mkdir -p "$DECDIR"
timeout 3 env -i \
  HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" PATH="$_SAFE_PATH" \
  SUPERVISOR_DECISIONS_DIR="$DECDIR" AGENT_NAME=test_agent \
  /bin/bash "$WRAPPER" -c 'git push origin main' >/dev/null 2>&1
C3C=$?
[ "$C3C" -ne 0 ] \
  && _ok "no decision within timeout → non-zero exit" \
  || _fail "no decision within timeout → non-zero exit (got exit $C3C)"

echo ""
echo "=== AC6: SUPERVISOR_DECISIONS_DIR unset → exit 1 + stderr warning ==="

STDERR_AC6="$WORK/ac6_stderr.txt"
_wrap_run \
  AGENT_NAME=test_agent \
  /bin/bash "$WRAPPER" -c 'git push origin main' 2>"$STDERR_AC6"
C_AC6=$?
WARN_MSG=$(cat "$STDERR_AC6" 2>/dev/null || true)
if [ "$C_AC6" -eq 1 ] && echo "$WARN_MSG" | grep -qi "SUPERVISOR_DECISIONS_DIR"; then
  _ok "SUPERVISOR_DECISIONS_DIR unset → exit 1 + warning"
else
  _fail "SUPERVISOR_DECISIONS_DIR unset → exit 1 + warning (exit=$C_AC6, stderr='$WARN_MSG')"
fi

echo ""
printf '=== Results: %d passed, %d failed ===\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
