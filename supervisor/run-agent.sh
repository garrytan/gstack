#!/usr/bin/env bash
# cstack autonomous agent loop v8 — real-time activity streaming
# Changes from v7:
#  - Switches to --output-format stream-json --verbose so tool calls are
#    visible in real-time instead of only available after session ends.
#  - Pipes claude output through stream-processor.py which writes:
#      logs/live.json        — current task, last tool, session duration (atomic)
#      logs/live-events.jsonl — append-only feed of every tool call
#    Both files are read by `fleet.sh watch` and `fleet.sh stream`.
#  - Presence file is now updated per tool call (last_tool, last_summary)
#    not just per session, so fleet.sh watch shows live activity.
#  - Metrics extraction unchanged: stream-processor.py emits a compatible
#    single JSON object at session end which the existing Python parser reads.
# Changes from v6 (also in v7):
#  - Presence beacon: writes mailboxes/presence/<agent>.json locally every 30s
#  - Fast idle wake: WAKE_CHECK_INTERVAL=5s (was 30); MAX_IDLE_WAIT=300s (was 1800)
#  - Local wake signals: after each session push, writes mailboxes/wake/<recipient>
#    for any same-machine agents that received mailbox messages. Recipients wake in <1s.
#  - Supabase Realtime broadcast: if SUPABASE_URL + SUPABASE_KEY are set in config,
#    broadcasts wake events cross-machine and runs wake-listen.ts as a background
#    subscriber so this agent wakes within ~1s from any machine.
#  - Parallel answer sessions: a background watcher detects incoming awaiting_info
#    questions while a main session is running and immediately spawns a focused
#    answer-only claude session in a dedicated git worktree (no index conflicts).
#  - Answer worktree: $AGENT_HOME/answer-wt — separate checkout of control repo
#    so answer sessions never touch the main session's git index.
#  - Process supervision: pair with install.sh for launchd/systemd auto-restart.
#
# Optional config keys (add to ~/agents/<agent-name>/config):
#   SUPABASE_URL=https://<project>.supabase.co
#   SUPABASE_KEY=<anon-or-service-role-key>
#
# Usage: ./run-agent.sh <agent-name> <role-file> [model]
# Examples:
#   ./run-agent.sh agent-be  FEATURE_ROLE.md claude-sonnet-4-6
#   ./run-agent.sh agent-fe  FEATURE_ROLE.md claude-sonnet-4-6
#   ./run-agent.sh agent-qa  QA_ROLE.md
#   ./run-agent.sh agent-doc DOC_ROLE.md
#
# Per-agent config: ~/agents/<agent-name>/config (required keys)
#   CONTROL_REPO_URL=git@github.com:org/control.git
#   WORK_REPO_URL=git@github.com:org/work.git   # empty for QA/doc agents
#   AGENT_DOMAIN=be                              # be | fe | full | qa | doc
#   READ_REPOS="git@github.com:org/api.git ..."  # optional, read-only
#   SECRET_PREFIX=<engagement-slug>              # QA agent only — namespaces
#                                                # secret files in ~/.cstack-secrets/
#                                                # (e.g. SECRET_PREFIX=acme → reads
#                                                # ~/.cstack-secrets/acme-qa-user etc.)
#                                                # Non-QA agents ignore this key.

set -u

SUPERVISOR_DIR="$(cd "$(dirname "$0")" && pwd)"
STREAM_PROCESSOR="$SUPERVISOR_DIR/stream-processor.py"
# shellcheck disable=SC1091
. "$SUPERVISOR_DIR/cost-guards.sh"

# Cost guards (override via per-agent config or env):
#   IDLE_PRESKIP=1            skip claude session when kernel says no work AND
#                              mailbox is empty (saves ~$0.24 per idle iter).
#   SESSION_TIMEOUT=600       hard wall-clock cap on each claude invocation
#                              (seconds). Set 0 to disable.
IDLE_PRESKIP="${IDLE_PRESKIP:-1}"
SESSION_TIMEOUT="${SESSION_TIMEOUT:-600}"

AGENT_NAME="${1:?Usage: run-agent.sh <agent-name> <role-file> [model]}"
ROLE_FILE="${2:?Provide a role file, e.g. FEATURE_ROLE.md}"
MODEL="${3:-claude-sonnet-4-6}"

AGENT_HOME="$HOME/agents/$AGENT_NAME"
CONFIG="$AGENT_HOME/config"
CONTROL_DIR="$AGENT_HOME/control"
WORK_DIR="$AGENT_HOME/work"
READ_DIR="$AGENT_HOME/read"
LOG_DIR="$AGENT_HOME/logs"
WAKE_CHECK_INTERVAL=5     # seconds between ls-remote checks while idle (was 30)
MAX_IDLE_WAIT=300         # safety-net wake after 5 min even if nothing changed (was 1800)
MAX_CONSECUTIVE_FAILS=3
PRESENCE_INTERVAL=30      # seconds between presence heartbeat writes

# Paths for real-time coordination (local only — gitignored in control repo)
MAILBOX_FILE=""           # set after CONTROL_DIR confirmed
WAKE_FILE=""
PRESENCE_FILE=""
AGENT_STATE_FILE=""
ANSWER_WT="$AGENT_HOME/answer-wt"

[ -f "$CONFIG" ] || { echo "Missing config: $CONFIG"; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
mkdir -p "$LOG_DIR"

# Optional Supabase config (skip broadcast/listen if absent)
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_KEY:-}"

# Init local coordination paths (control dir may not exist yet before clone)
_init_collab_paths() {
  MAILBOX_FILE="$CONTROL_DIR/mailboxes/$AGENT_NAME.md"
  WAKE_FILE="$CONTROL_DIR/mailboxes/wake/$AGENT_NAME"
  PRESENCE_FILE="$CONTROL_DIR/mailboxes/presence/$AGENT_NAME.json"
  AGENT_STATE_FILE="$LOG_DIR/.agent_state"
  mkdir -p "$CONTROL_DIR/mailboxes/presence" "$CONTROL_DIR/mailboxes/wake" 2>/dev/null || true
}

# --- Presence beacon ----------------------------------------------------------
# Writes a local JSON presence file every PRESENCE_INTERVAL seconds.
# Local only — not committed to git. Other agents on the same machine can read
# these files to check if a peer is alive (mtime < 60s means live).

write_presence() {
  local state="$1"
  [ -z "$PRESENCE_FILE" ] && return 0
  echo "$state" > "$AGENT_STATE_FILE" 2>/dev/null || true
  printf '{"agent":"%s","pid":%d,"state":"%s","ts":"%s"}\n' \
    "$AGENT_NAME" "$$" "$state" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$PRESENCE_FILE" 2>/dev/null || true
}

start_presence_beacon() {
  (
    while true; do
      state=$(cat "$AGENT_STATE_FILE" 2>/dev/null || echo "unknown")
      printf '{"agent":"%s","pid":%d,"state":"%s","ts":"%s"}\n' \
        "$AGENT_NAME" "$$" "$state" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        > "$PRESENCE_FILE" 2>/dev/null || true
      sleep "$PRESENCE_INTERVAL"
    done
  ) &
  BEACON_PID=$!
}

# --- Supabase Realtime --------------------------------------------------------
# broadcast_wake: curl-based, fires after each session push. Service-role key
# (or anon key with broadcast enabled) required for REST broadcast endpoint.

broadcast_wake() {
  local recipient="$1"
  [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ] && return 0
  curl -s -X POST \
    "${SUPABASE_URL}/realtime/v1/api/broadcast" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"messages\":[{\"topic\":\"agent-wakes\",\"event\":\"wake\",\"payload\":{\"agent\":\"${recipient}\"}}]}" \
    > /dev/null 2>&1 || true
}

start_wake_listener() {
  [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ] && return 0
  local listener_script
  listener_script="$(dirname "$0")/wake-listen.ts"
  [ -f "$listener_script" ] || { echo "[$AGENT_NAME] wake-listen.ts not found, skipping Supabase listener"; return 0; }
  (
    while true; do
      bun run "$listener_script" "$AGENT_NAME" "$CONTROL_DIR" "$SUPABASE_URL" "$SUPABASE_KEY" \
        >> "$LOG_DIR/wake-listen.log" 2>&1 || true
      echo "[$AGENT_NAME] wake-listen.ts exited, restarting in 5s..." >> "$LOG_DIR/wake-listen.log"
      sleep 5
    done
  ) &
  WAKE_LISTENER_PID=$!
  echo "[$AGENT_NAME] Supabase wake listener started (PID $WAKE_LISTENER_PID)"
}

# --- Same-machine wake signals ------------------------------------------------
# After each session, diff what changed in control repo and write local wake
# files for any recipient mailboxes that were modified. Agents sleeping in
# idle_wait() check this file every 1s and wake immediately.

notify_local_agents() {
  local before="$1"
  local changed
  changed=$(git -C "$CONTROL_DIR" diff --name-only "$before" HEAD 2>/dev/null \
    | grep '^mailboxes/[^/]*\.md$' \
    | grep -v "^mailboxes/${AGENT_NAME}\.md$" || true)
  [ -z "$changed" ] && return 0
  mkdir -p "$CONTROL_DIR/mailboxes/wake" 2>/dev/null || true
  for f in $changed; do
    local recipient
    recipient=$(basename "$f" .md)
    touch "$CONTROL_DIR/mailboxes/wake/$recipient" 2>/dev/null || true
    echo "[$AGENT_NAME] wake signal → $recipient"
    broadcast_wake "$recipient"
  done
}

# --- Idle wait ----------------------------------------------------------------
# Checks local wake file every 1s (fast path for same-machine agents), and
# polls git ls-remote every WAKE_CHECK_INTERVAL seconds (remote path).

idle_wait() {
  local LAST_SEEN
  LAST_SEEN=$(git -C "$CONTROL_DIR" rev-parse HEAD 2>/dev/null || echo "")
  local IDLE_START
  IDLE_START=$(date +%s)
  echo "[$AGENT_NAME] no eligible tasks — descheduled (wake file: 1s, ls-remote: ${WAKE_CHECK_INTERVAL}s, max: ${MAX_IDLE_WAIT}s)"

  while true; do
    # 1s resolution: local wake file (same-machine fast path)
    local elapsed=0
    while [ "$elapsed" -lt "$WAKE_CHECK_INTERVAL" ]; do
      if [ -f "$WAKE_FILE" ]; then
        rm -f "$WAKE_FILE" 2>/dev/null || true
        echo "[$AGENT_NAME] local wake signal — waking"
        return
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done

    # 5s resolution: remote git ls-remote
    local REMOTE_HEAD
    REMOTE_HEAD=$(git -C "$CONTROL_DIR" ls-remote -q origin HEAD 2>/dev/null | cut -f1)
    if [ -n "$REMOTE_HEAD" ] && [ "$REMOTE_HEAD" != "$LAST_SEEN" ]; then
      echo "[$AGENT_NAME] control repo changed ($REMOTE_HEAD) — waking"
      return
    fi

    local IDLE_NOW
    IDLE_NOW=$(date +%s)
    if [ $((IDLE_NOW - IDLE_START)) -ge "$MAX_IDLE_WAIT" ]; then
      echo "[$AGENT_NAME] max idle wait reached — waking for safety-net check"
      return
    fi
  done
}

# --- Parallel answer sessions -------------------------------------------------
# While a main session is running, this background watcher polls the remote
# control repo every 5s. If it detects that THIS agent's mailbox changed on
# remote (someone else wrote to it while we're mid-task), it immediately
# launches a focused answer session in the ANSWER_WT worktree so the question
# is answered without waiting for the main session to finish.
#
# The answer session uses a separate git worktree (ANSWER_WT) to avoid
# git index conflicts with the concurrently-running main session.

_launch_answer_session() {
  local answer_id="${AGENT_NAME}_answer_$(date +%Y%m%d-%H%M%S)"
  local answer_log="$LOG_DIR/${answer_id}.json"

  # Sync answer worktree to latest remote state
  git -C "$ANSWER_WT" pull --rebase -q origin 2>/dev/null || true

  local prompt
  prompt="You are $AGENT_NAME (role: $AGENT_ROLE, domain: $AGENT_DOMAIN).

FOCUSED ANSWER SESSION — do NOT claim, pick, or work on any tasks.

Another agent has sent you an awaiting_info question while you are mid-session.
Your mailbox is at mailboxes/$AGENT_NAME.md.

Do exactly this and nothing else:
1. Read mailboxes/$AGENT_NAME.md
2. For each message referencing an awaiting_info task:
   a. Read the task spec (./kernel/task show <id>)
   b. Write a ## Q&A section in the task spec file with your answer
   c. Run: ./kernel/task resume <id> --agent $AGENT_NAME --role $AGENT_ROLE
   d. Append to mailboxes/<sender>.md:
      ## from: $AGENT_NAME | <ISO ts> | re: <task-id>
      <your answer — one precise paragraph>
3. Append to PROGRESS.md:
   ## $AGENT_NAME | <ts> | answer session
   Answered awaiting_info question on <task-id>. Resumed task.
4. Clear your mailbox: set it to <!-- cleared by $AGENT_NAME at <ts> -->
5. Commit all changes: 'mailbox($AGENT_NAME): answered awaiting_info on <task-id>'
6. Push. If push is rejected, pull --rebase and push again once.
7. Exit."

  echo "[$AGENT_NAME] launching answer session → $answer_log"
  (
    cd "$ANSWER_WT" || exit 1
    claude --dangerously-skip-permissions \
           --add-dir "$ANSWER_WT" \
           -p "$prompt" \
           --model "$MODEL" \
           --output-format json
  ) > "$answer_log" 2>&1
  local exit_code=$?
  echo "[$AGENT_NAME] answer session done (exit $exit_code, log: $answer_log)"
}

watch_mailbox_background() {
  local initial_hash="$1"
  local current_hash="$initial_hash"
  local answer_in_flight=0

  while true; do
    sleep 5
    git -C "$CONTROL_DIR" fetch -q origin 2>/dev/null || { sleep 5; continue; }

    local new_hash
    new_hash=$(git -C "$CONTROL_DIR" ls-tree FETCH_HEAD "mailboxes/$AGENT_NAME.md" 2>/dev/null | awk '{print $3}' || echo "")

    if [ -n "$new_hash" ] && [ "$new_hash" != "$current_hash" ] && [ "$answer_in_flight" -eq 0 ]; then
      current_hash="$new_hash"
      # Only launch if the mailbox has actual content (not just the "cleared" marker)
      local mailbox_content
      mailbox_content=$(git -C "$CONTROL_DIR" show "FETCH_HEAD:mailboxes/$AGENT_NAME.md" 2>/dev/null || echo "")
      if echo "$mailbox_content" | grep -q '^## from:'; then
        answer_in_flight=1
        _launch_answer_session
        answer_in_flight=0
      fi
    fi
  done
}

# --- One-time setup -----------------------------------------------------------

if [ ! -d "$CONTROL_DIR/.git" ]; then
  git clone "$CONTROL_REPO_URL" "$CONTROL_DIR" || { echo "control clone failed"; exit 1; }
fi
if [ -n "${WORK_REPO_URL:-}" ] && [ ! -d "$WORK_DIR/.git" ]; then
  git clone "$WORK_REPO_URL" "$WORK_DIR" || { echo "work clone failed"; exit 1; }
fi

READ_DIRS=()
if [ -n "${READ_REPOS:-}" ]; then
  mkdir -p "$READ_DIR"
  for url in $READ_REPOS; do
    name=$(basename "$url" .git)
    dest="$READ_DIR/$name"
    if [ ! -d "$dest/.git" ]; then
      git clone "$url" "$dest" || { echo "read clone failed: $url"; exit 1; }
    fi
    READ_DIRS+=("$dest")
  done
fi

AGENT_ROLE=$(basename "$ROLE_FILE" | sed 's/_ROLE.*//' | tr '[:upper:]' '[:lower:]')

# Metrics worktree (dedicated branch, keeps main history clean)
METRICS_WT="$AGENT_HOME/metrics-wt"
if [ ! -d "$METRICS_WT/.git" ] && [ ! -f "$METRICS_WT/.git" ]; then
  git -C "$CONTROL_DIR" fetch -q origin metrics 2>/dev/null || true
  if git -C "$CONTROL_DIR" show-ref -q refs/remotes/origin/metrics; then
    git -C "$CONTROL_DIR" worktree add -q "$METRICS_WT" -B metrics origin/metrics
  else
    git -C "$CONTROL_DIR" worktree add -q "$METRICS_WT" -b metrics
  fi
fi
METRICS_FILE="$METRICS_WT/METRICS.jsonl"
mkdir -p "$(dirname "$METRICS_FILE")"

# Answer worktree (separate checkout for parallel answer sessions)
if [ ! -d "$ANSWER_WT/.git" ] && [ ! -f "$ANSWER_WT/.git" ]; then
  git -C "$CONTROL_DIR" worktree add -q "$ANSWER_WT" HEAD
fi

# QA credentials (staging only, never committed) — QA agents only.
# All other roles skip this block entirely; they have no business reading
# secrets and should never have $QA_USER etc. in their environment.
#
# Secret file format (created by `bin/cstack-qa-secrets-init`):
#   line 1 = username (email or login)
#   line 2 = password
#
# Files (all chmod 600, in chmod 700 dir):
#   ~/.cstack-secrets/${SECRET_PREFIX}-qa                 → $QA_USER, $QA_PASS
#   ~/.cstack-secrets/${SECRET_PREFIX}-qa-actor-<role>    → $QA_ACTOR_<ROLE>_USER, $QA_ACTOR_<ROLE>_PASS
#
# $SECRET_PREFIX is read from the per-agent config (see header). If unset or
# the files are missing, no env vars are exported and QA work will (correctly)
# fail with qa_status: env_error.
if [ "$AGENT_ROLE" = "qa" ]; then
  SECRET_PREFIX="${SECRET_PREFIX:-}"
  if [ -n "$SECRET_PREFIX" ] && [ -d "$HOME/.cstack-secrets" ]; then
    # Single-user identity for /qa
    _qa_file="$HOME/.cstack-secrets/${SECRET_PREFIX}-qa"
    if [ -f "$_qa_file" ]; then
      export QA_USER QA_PASS
      QA_USER="$(sed -n '1p' "$_qa_file")"
      QA_PASS="$(sed -n '2p' "$_qa_file")"
    fi
    unset _qa_file

    # Per-role identities for /workflow-qa
    for _actor_file in "$HOME/.cstack-secrets/${SECRET_PREFIX}-qa-actor-"*; do
      [ -f "$_actor_file" ] || continue
      _actor_role="${_actor_file##*/${SECRET_PREFIX}-qa-actor-}"
      _actor_key="$(echo "$_actor_role" | tr '[:lower:]-' '[:upper:]_')"
      _user_var="QA_ACTOR_${_actor_key}_USER"
      _pass_var="QA_ACTOR_${_actor_key}_PASS"
      export "$_user_var" "$_pass_var"
      eval "$_user_var=\$(sed -n '1p' \"\$_actor_file\")"
      eval "$_pass_var=\$(sed -n '2p' \"\$_actor_file\")"
    done
    unset _actor_file _actor_role _actor_key _user_var _pass_var
  fi
fi

export AGENT_NAME AGENT_DOMAIN AGENT_ROLE CONTROL_DIR WORK_DIR READ_DIR

_init_collab_paths

# Start presence beacon and Supabase wake listener (once, not per iteration)
BEACON_PID=""
WAKE_LISTENER_PID=""
start_presence_beacon
start_wake_listener

echo "[$AGENT_NAME] supervisor v7 — role: $ROLE_FILE, domain: ${AGENT_DOMAIN:-?}, model: $MODEL"
echo "[$AGENT_NAME] control: $CONTROL_DIR  work: ${WORK_REPO_URL:-<none>}  read: ${READ_REPOS:-<none>}"
echo "[$AGENT_NAME] realtime: wake_interval=${WAKE_CHECK_INTERVAL}s, idle_max=${MAX_IDLE_WAIT}s, supabase=$([ -n "$SUPABASE_URL" ] && echo enabled || echo disabled)"

consecutive_fails=0

cleanup() {
  write_presence "stopped"
  [ -n "$BEACON_PID" ] && kill "$BEACON_PID" 2>/dev/null || true
  [ -n "$WAKE_LISTENER_PID" ] && kill "$WAKE_LISTENER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Main loop ----------------------------------------------------------------

while true; do
  # Sync everything before each session
  git -C "$CONTROL_DIR" pull --rebase --quiet || true
  [ -d "$WORK_DIR/.git" ] && { git -C "$WORK_DIR" pull --rebase --quiet || true; }
  for rd in "${READ_DIRS[@]:-}"; do
    [ -n "$rd" ] && git -C "$rd" pull --quiet || true
  done

  COMMIT_CTRL=$(git -C "$CONTROL_DIR" rev-parse HEAD 2>/dev/null || echo "nogit")
  CTRL_HEAD_BEFORE="$COMMIT_CTRL"   # snapshot for post-session notify_local_agents
  TS_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  EPOCH_START=$(date +%s)
  RUN_ID="${AGENT_NAME}_$(date +%Y%m%d-%H%M%S)_${COMMIT_CTRL}"
  JSONFILE="$LOG_DIR/${RUN_ID}.json"

  echo "[$AGENT_NAME] iteration start @ control:$COMMIT_CTRL"
  write_presence "working"

  # ----- Cost guard: idle preskip ---------------------------------------------
  # If the kernel says no eligible work AND our mailbox has no incoming
  # messages, skip launching claude entirely. We still record a synthetic
  # no_work metric line so metrics-report.sh sees the iteration.
  WORK_REPO_NAME=""
  if [ -n "${WORK_REPO_URL:-}" ]; then
    WORK_REPO_NAME=$(basename "$WORK_REPO_URL" .git)
  fi
  export AGENT_DOMAIN WORK_REPO_NAME
  if should_skip_idle_session "$CONTROL_DIR" "$AGENT_NAME" "$AGENT_ROLE"; then
    echo "[$AGENT_NAME] preskip: no eligible tasks + empty mailbox — skipping claude session"
    EPOCH_END=$(date +%s)
    DURATION=$((EPOCH_END - EPOCH_START))
    SKIP_METRIC=$(printf '{"ts":"%s","agent":"%s","duration_s":%d,"exit_code":0,"control_commit":"%s","task":null,"outcome":"no_work","input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cost_usd":0,"num_turns":0,"no_work":true,"context_exhausted":false,"preskip":true}' \
      "$TS_START" "$AGENT_NAME" "$DURATION" "$COMMIT_CTRL")
    echo "$SKIP_METRIC" >> "$METRICS_FILE" 2>/dev/null || true
    consecutive_fails=0
    write_presence "idle"
    idle_wait
    continue
  fi
  # ----------------------------------------------------------------------------

  # Snapshot mailbox blob hash so the watcher can detect incoming messages
  MAILBOX_HASH=$(git -C "$CONTROL_DIR" ls-tree HEAD "mailboxes/$AGENT_NAME.md" 2>/dev/null | awk '{print $3}' || echo "")

  # Build --add-dir flags
  ADD_DIRS=(--add-dir "$CONTROL_DIR")
  for rd in "${READ_DIRS[@]:-}"; do
    [ -n "$rd" ] && ADD_DIRS+=(--add-dir "$rd")
  done

  RUN_CWD="$WORK_DIR"; [ -d "$WORK_DIR/.git" ] || RUN_CWD="$CONTROL_DIR"

  # Start background mailbox watcher for parallel answer sessions
  WATCHER_PID=""
  watch_mailbox_background "$MAILBOX_HASH" &
  WATCHER_PID=$!

  # Run claude with stream-json so tool calls are visible in real-time.
  # stream-processor.py writes live.json + live-events.jsonl and emits
  # a metrics-compatible JSON summary to stdout at session end.
  # Wall-clock cap: SESSION_TIMEOUT seconds (default 600). 124 = killed by
  # watchdog — recorded as a crash via existing exit-code path.
  (
    set -o pipefail
    cd "$RUN_CWD" || exit 1
    run_with_timeout "$SESSION_TIMEOUT" \
      claude --dangerously-skip-permissions \
           "${ADD_DIRS[@]}" \
           -p "$(cat "$CONTROL_DIR/AGENT_BASE.md" "$CONTROL_DIR/roles/$ROLE_FILE")" \
           --model "$MODEL" \
           --output-format stream-json \
           --verbose \
           2> "$LOG_DIR/${RUN_ID}.stderr" \
    | python3 "$STREAM_PROCESSOR" "$LOG_DIR" "$AGENT_NAME" "$CONTROL_DIR"
  ) > "$JSONFILE"
  EXIT_CODE=$?
  EPOCH_END=$(date +%s)
  DURATION=$((EPOCH_END - EPOCH_START))

  # Stop mailbox watcher
  [ -n "$WATCHER_PID" ] && kill "$WATCHER_PID" 2>/dev/null || true

  # Safety: hard-reset any read-only repo drift
  for rd in "${READ_DIRS[@]:-}"; do
    [ -n "$rd" ] && git -C "$rd" reset --hard -q HEAD 2>/dev/null && git -C "$rd" clean -fdq 2>/dev/null || true
  done

  # Notify same-machine agents + broadcast via Supabase for any mailbox messages we sent
  notify_local_agents "$CTRL_HEAD_BEFORE"

  # --- Extract metrics from session JSON ---
  METRIC_LINE=$(python3 - "$JSONFILE" "$AGENT_NAME" "$TS_START" "$DURATION" "$EXIT_CODE" "$COMMIT_CTRL" <<'PYEOF'
import json, sys, re
jsonfile, agent, ts, dur, exit_code, c_ctrl = sys.argv[1:7]
m = {"ts": ts, "agent": agent, "duration_s": int(dur), "exit_code": int(exit_code),
     "control_commit": c_ctrl, "task": None, "outcome": "unknown",
     "input_tokens": None, "output_tokens": None, "cache_read_tokens": None,
     "cost_usd": None, "num_turns": None, "no_work": False, "context_exhausted": False}
try:
    data = json.load(open(jsonfile))
    u = data.get("usage", {}) or {}
    m.update(input_tokens=u.get("input_tokens"), output_tokens=u.get("output_tokens"),
             cache_read_tokens=u.get("cache_read_input_tokens"),
             cost_usd=data.get("total_cost_usd") or data.get("cost_usd"),
             num_turns=data.get("num_turns"))
    txt = data.get("result", "") or ""
    if "NO_ELIGIBLE_TASKS" in txt:
        m["no_work"] = True; m["outcome"] = "no_work"
    tm = re.search(r'(?:claim|feat|fix|qa|qa-claim|docs|doc-claim|bug)\(([A-Z0-9][A-Z0-9-]+)\)', txt)
    if tm: m["task"] = tm.group(1)
    low = txt.lower()
    if m["outcome"] != "no_work":
        if "needs_human" in low: m["outcome"] = "needs_human"
        elif re.search(r'status:\s*done|marked done|qa_status:\s*passed|doc_status:\s*updated', low): m["outcome"] = "done"
        elif int(exit_code) == 0: m["outcome"] = "completed_session"
        else: m["outcome"] = "crashed"
    if data.get("is_error") and "context" in str(data.get("result","")).lower():
        m["context_exhausted"] = True
except Exception as e:
    m["outcome"] = "metrics_parse_error"; m["parse_error"] = str(e)[:200]
print(json.dumps(m, separators=(",", ":")))
PYEOF
)
  # Push metric to dedicated metrics branch.
  # METRICS.jsonl is append-only: when push is rejected (concurrent agent push),
  # we fetch + reset --hard (never rebase — rebase on JSONL causes stuck conflicts)
  # then re-append our line and push again.
  _push_metric() {
    local line="$1"
    echo "$line" >> "$METRICS_FILE"
    git -C "$METRICS_WT" add METRICS.jsonl 2>/dev/null || return 0
    git -C "$METRICS_WT" diff --cached --quiet 2>/dev/null && return 0   # nothing to commit
    git -C "$METRICS_WT" commit -qm "metrics(${AGENT_NAME}): ${RUN_ID}" 2>/dev/null || return 0
    if ! git -C "$METRICS_WT" push -q -u origin metrics 2>/dev/null; then
      # Push rejected — reset to remote, re-append, re-commit, push once more
      git -C "$METRICS_WT" fetch -q origin metrics 2>/dev/null || return 0
      git -C "$METRICS_WT" reset --hard origin/metrics 2>/dev/null || return 0
      echo "$line" >> "$METRICS_FILE"
      git -C "$METRICS_WT" add METRICS.jsonl 2>/dev/null || return 0
      git -C "$METRICS_WT" commit -qm "metrics(${AGENT_NAME}): ${RUN_ID}" 2>/dev/null || return 0
      git -C "$METRICS_WT" push -q -u origin metrics 2>/dev/null || true
    fi
  }
  _push_metric "$METRIC_LINE"

  # --- Circuit breaker ---
  if [ $EXIT_CODE -ne 0 ]; then
    consecutive_fails=$((consecutive_fails + 1))
    echo "[$AGENT_NAME] session exited $EXIT_CODE (fail $consecutive_fails/$MAX_CONSECUTIVE_FAILS)"
    if [ $consecutive_fails -ge $MAX_CONSECUTIVE_FAILS ]; then
      echo "[$AGENT_NAME] ESCALATION: stopping. Human needed. Last: $JSONFILE"
      exit 1
    fi
  else
    consecutive_fails=0
  fi

  # --- Idle wait (event-driven, BEAM receive-style) ---
  if echo "$METRIC_LINE" | grep -q '"no_work":true'; then
    write_presence "idle"
    idle_wait
  fi
done
