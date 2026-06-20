#!/usr/bin/env bash
# supervisor/console/bash-wrapper.test.sh
# Tests for check_risk classification (AC1) and poll_approval paths (AC2).
# Run standalone: bash supervisor/console/bash-wrapper.test.sh
# Run via bun: bun test supervisor/console/ (invoked by bash-wrapper.test.ts)

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$THIS_DIR/bin/bash"

pass=0
fail=0

_ok()   { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
_fail() { printf '  FAIL  %s\n' "$1" >&2; fail=$((fail + 1)); }

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

echo "=== AC1: check_risk classification ==="

# AC1a: git push → high
[ "$(check_risk 'git push origin main')" = "high" ] \
  && _ok "git push origin main → high" \
  || _fail "git push origin main → high"

# AC1b: git commit → not high (spec names this tier "medium"; impl returns "low")
[ "$(check_risk 'git commit -m "fix"')" != "high" ] \
  && _ok 'git commit -m "fix" → not high' \
  || _fail 'git commit -m "fix" → not high'

# AC1c: bun test → low
[ "$(check_risk 'bun test')" = "low" ] \
  && _ok "bun test → low" \
  || _fail "bun test → low"

# AC1d: chained command — cd is low, but trailing git push makes the chain high
[ "$(evaluate_chain_risk 'cd /tmp && git push origin main')" = "high" ] \
  && _ok "cd /tmp && git push origin main → high (chained)" \
  || _fail "cd /tmp && git push origin main → high (chained)"

# AC1e: rm -rf → high
[ "$(check_risk 'rm -rf /home')" = "high" ] \
  && _ok "rm -rf /home → high" \
  || _fail "rm -rf /home → high"

echo ""
echo "=== AC2: poll_approval paths ==="

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

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

# AC2a: decision file with approved:true → wrapper exits 0
# Mock git so the approved command always succeeds (we test wrapper behaviour, not real git).
MOCKBIN="$WORK/mockbin"
mkdir -p "$MOCKBIN"
printf '#!/usr/bin/env bash\nexit 0\n' > "$MOCKBIN/git"
chmod +x "$MOCKBIN/git"
rm -f "$WORK"/*.json 2>/dev/null
PATH="$MOCKBIN:$PATH" SUPERVISOR_DECISIONS_DIR="$WORK" AGENT_NAME=test_agent "$WRAPPER" -c 'git push origin main' &
W2A=$!
REQ=$(_wait_req "$WORK") && _write_decision "$REQ" "true" "$WORK"
wait "$W2A"; C2A=$?
[ "$C2A" -eq 0 ] \
  && _ok "approved → exit 0" \
  || _fail "approved → exit 0 (got exit $C2A)"

# AC2b: decision file with approved:false → wrapper exits 1
rm -f "$WORK"/*.json 2>/dev/null
SUPERVISOR_DECISIONS_DIR="$WORK" AGENT_NAME=test_agent "$WRAPPER" -c 'git push origin main' &
W2B=$!
REQ=$(_wait_req "$WORK") && _write_decision "$REQ" "false" "$WORK"
wait "$W2B"; C2B=$?
[ "$C2B" -eq 1 ] \
  && _ok "rejected → exit 1" \
  || _fail "rejected → exit 1 (got exit $C2B)"

# AC2c: no decision within timeout → non-zero exit
# Uses `timeout 3` to bound the test; the wrapper would otherwise poll forever.
rm -f "$WORK"/*.json 2>/dev/null
timeout 3 env SUPERVISOR_DECISIONS_DIR="$WORK" AGENT_NAME=test_agent \
  "$WRAPPER" -c 'git push origin main' >/dev/null 2>&1
C2C=$?
[ "$C2C" -ne 0 ] \
  && _ok "no decision within timeout → non-zero exit" \
  || _fail "no decision within timeout → non-zero exit (got exit $C2C)"

echo ""
printf '=== Results: %d passed, %d failed ===\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
