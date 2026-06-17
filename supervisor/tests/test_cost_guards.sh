#!/usr/bin/env bash
# test_cost_guards.sh — contract test for supervisor/cost-guards.sh.
#
# Exercises both helpers in isolation (no real claude, no real kernel/task,
# no network). Runs fast (< 5s) and is safe to add to CI.
#
# Run: bash supervisor/tests/test_cost_guards.sh

set -e

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARDS="$THIS_DIR/../cost-guards.sh"
[ -f "$GUARDS" ] || { echo "FAIL: $GUARDS missing"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# shellcheck disable=SC1090
. "$GUARDS"

pass=0
fail=0

_check() {
  local name="$1"; shift
  if "$@"; then
    printf '  ok    %s\n' "$name"
    pass=$((pass+1))
  else
    printf '  FAIL  %s\n' "$name"
    fail=$((fail+1))
  fi
}

# --- Fixture: fake control dir with a fake kernel/task ------------------------
make_control() {
  local dir="$1"
  local exit_code="$2"
  mkdir -p "$dir/kernel" "$dir/mailboxes"
  cat > "$dir/kernel/task" <<EOF
#!/usr/bin/env bash
# Mock kernel. Exits with $exit_code on 'eligible', 0 otherwise.
if [ "\$1" = "eligible" ]; then exit $exit_code; fi
exit 0
EOF
  chmod +x "$dir/kernel/task"
}

# --- Test 1: empty backlog + empty mailbox → preskip says SKIP ----------------
echo "[1] preskip with empty backlog + empty mailbox"
CTRL1="$WORK/ctrl1"
make_control "$CTRL1" 3   # 3 = NO_ELIGIBLE_TASKS
AGENT_DOMAIN=be WORK_REPO_NAME=r1 IDLE_PRESKIP=1 \
  should_skip_idle_session "$CTRL1" agent-be feature
_check "preskip returns 0 (skip) when no eligible + no mail" [ $? -eq 0 ]

# --- Test 2: work available → preskip says DON'T skip -------------------------
echo "[2] preskip aborts when work is available"
CTRL2="$WORK/ctrl2"
make_control "$CTRL2" 0   # 0 = work available
set +e
AGENT_DOMAIN=be WORK_REPO_NAME=r1 IDLE_PRESKIP=1 \
  should_skip_idle_session "$CTRL2" agent-be feature
rc=$?
set -e
_check "preskip returns 1 (don't skip) when work is eligible" [ "$rc" -eq 1 ]

# --- Test 3: mailbox has incoming message → preskip says DON'T skip -----------
echo "[3] preskip aborts when mailbox has a message"
CTRL3="$WORK/ctrl3"
make_control "$CTRL3" 3   # backlog says no work
cat > "$CTRL3/mailboxes/agent-be.md" <<'EOF'
## from: agent-fe | 2026-06-17T10:00:00Z | re: BUG-1
please look at this
EOF
set +e
AGENT_DOMAIN=be WORK_REPO_NAME=r1 IDLE_PRESKIP=1 \
  should_skip_idle_session "$CTRL3" agent-be feature
rc=$?
set -e
_check "preskip returns 1 when mailbox has '## from:' message" [ "$rc" -eq 1 ]

# --- Test 4: IDLE_PRESKIP=0 disables guard entirely ---------------------------
echo "[4] IDLE_PRESKIP=0 disables the guard"
set +e
AGENT_DOMAIN=be WORK_REPO_NAME=r1 IDLE_PRESKIP=0 \
  should_skip_idle_session "$CTRL1" agent-be feature
rc=$?
set -e
_check "preskip returns 1 (disabled) even when no work" [ "$rc" -eq 1 ]

# --- Test 5: cleared-marker mailbox is treated as empty -----------------------
echo "[5] cleared-marker mailbox counts as empty"
CTRL5="$WORK/ctrl5"
make_control "$CTRL5" 3
echo '<!-- cleared by agent-be at 2026-06-17T09:00:00Z -->' > "$CTRL5/mailboxes/agent-be.md"
AGENT_DOMAIN=be WORK_REPO_NAME=r1 IDLE_PRESKIP=1 \
  should_skip_idle_session "$CTRL5" agent-be feature
_check "preskip returns 0 when mailbox has only the cleared marker" [ $? -eq 0 ]

# --- Test 6: run_with_timeout kills a runaway and reports 124 -----------------
echo "[6] run_with_timeout kills a runaway and exits 124"
START=$(date +%s)
set +e
run_with_timeout 1 sleep 30
rc=$?
set -e
ELAPSED=$(( $(date +%s) - START ))
_check "runaway killed within 5s wall-clock" [ "$ELAPSED" -lt 5 ]
_check "runaway exit code is 124 (matches GNU timeout)" [ "$rc" -eq 124 ]

# --- Test 7: run_with_timeout passes through a fast command unchanged ---------
echo "[7] run_with_timeout passes through a fast command"
set +e
run_with_timeout 5 bash -c 'exit 7'
rc=$?
set -e
_check "fast command exit code preserved" [ "$rc" -eq 7 ]

# --- Test 8: SESSION_TIMEOUT=0 disables the cap -------------------------------
echo "[8] SESSION_TIMEOUT=0 means no cap"
set +e
run_with_timeout 0 bash -c 'exit 3'
rc=$?
set -e
_check "timeout=0 still runs command and returns its exit" [ "$rc" -eq 3 ]

# --- Summary ------------------------------------------------------------------
echo
echo "cost-guards: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
echo "cost-guards: ALL PASS"
