#!/usr/bin/env bash
# cost-guards.sh — credit-burn guards for the cstack agent supervisor.
#
# Two helpers, sourced by run-agent.sh:
#
#   should_skip_idle_session  <control-dir> <agent-name> <role>
#       Exit 0 = nothing to do AND no mail; supervisor should skip the
#                claude session entirely and go straight to idle_wait.
#       Exit 1 = work or mail present; supervisor must launch claude.
#
#   run_with_timeout <seconds> <cmd...>
#       Runs <cmd> under a wall-clock kill-switch. Portable across macOS and
#       Linux (no GNU `timeout` dependency). Exit code is the child's exit
#       code, or 124 if the watchdog fired (matches GNU timeout convention).
#
# Both are intentionally side-effect free apart from logging to stderr,
# and both can be tested in isolation (see supervisor/tests/test_cost_guards.sh).

set -u

# --- should_skip_idle_session -------------------------------------------------
# A "skip" iteration writes no metric, launches no claude session, and costs
# zero LLM tokens. The supervisor's main loop adds its own synthetic
# no_work metric line so the report still sees the iteration.

should_skip_idle_session() {
  local control_dir="$1"
  local agent_name="$2"
  local role="$3"

  # Guard: only skip if explicitly enabled. Default ON so existing fleets
  # benefit immediately, but operators can opt out with IDLE_PRESKIP=0.
  if [ "${IDLE_PRESKIP:-1}" != "1" ]; then
    return 1
  fi

  # Mailbox: skip only if missing or already cleared (no '## from:' header).
  local mbox="$control_dir/mailboxes/$agent_name.md"
  if [ -f "$mbox" ] && grep -q '^## from:' "$mbox" 2>/dev/null; then
    return 1
  fi

  # Eligibility: ask the kernel directly. Exit 3 = NO_ELIGIBLE_TASKS.
  # Any other exit (including 0 = work available, 1 = error) → don't skip.
  local domain="${AGENT_DOMAIN:-}"
  local repo="${WORK_REPO_NAME:-}"
  local -a args=( eligible --role "$role" )
  [ -n "$domain" ] && args+=( --domain "$domain" )
  [ -n "$repo" ]   && args+=( --repo   "$repo" )

  # Capture rc via `|| rc=$?` so the helper survives a caller's `set -e`.
  local rc=0
  (
    cd "$control_dir" && ./kernel/task "${args[@]}" >/dev/null 2>&1
  ) || rc=$?

  if [ "$rc" -eq 3 ]; then
    # Even with no claimable tasks, don't skip if this agent already holds a
    # claim. Without this check, an agent that claims a task and then hits a
    # plan-session sleep wakes up, sees exit-3 from `task eligible` (because
    # its own claim isn't "eligible"), and skips the session forever.
    if grep -rl "^claimed_by: ${agent_name}$" "$control_dir/ledger/" \
         2>/dev/null | grep -q .; then
      return 1   # active claim — must launch session to continue it
    fi
    return 0   # skip
  fi
  return 1     # don't skip
}

# --- run_with_timeout ---------------------------------------------------------
# Portable wall-clock cap. Uses GNU `timeout` if available (Linux), otherwise
# a pure-bash watchdog that works on macOS without coreutils.

run_with_timeout() {
  local secs="$1"; shift

  # Zero or negative → no cap (back-compat for ops who want to disable).
  if [ -z "$secs" ] || [ "$secs" -le 0 ] 2>/dev/null; then
    "$@"
    return $?
  fi

  if command -v timeout >/dev/null 2>&1; then
    # No --preserve-status: a timeout returns 124 (GNU convention) instead of
    # 143 (SIGTERM-as-exit). Successful children still return their real code.
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi

  # Pure-bash watchdog (macOS default path).
  "$@" &
  local child=$!
  ( sleep "$secs" && kill -TERM "$child" 2>/dev/null ) &
  local watchdog=$!
  local rc=0
  wait "$child" 2>/dev/null
  rc=$?
  # Tear down watchdog if it's still alive (child exited first).
  kill -TERM "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null || true
  # If the child was killed by SIGTERM (143) report 124 like GNU timeout.
  if [ "$rc" -eq 143 ]; then
    return 124
  fi
  return "$rc"
}
