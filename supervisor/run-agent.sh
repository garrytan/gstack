#!/usr/bin/env bash
# cstack autonomous agent loop v6 — script-enforced ledger + metrics on dedicated branch
# Changes from v5:
#  - Ledger ops are performed by control/bin/task (deterministic); AGENT_ROLE exported for it.
#  - Metrics commit to a dedicated 'metrics' branch via a git worktree, keeping the control
#    repo's main history clean of per-session noise.
# Idle behavior (BEAM-style "receive"): when no eligible tasks exist, the harness does NOT
# re-launch Claude on a timer. It watches the control repo's remote HEAD with cheap
# `git ls-remote` calls and wakes the agent only when the control repo changes
# (new task, mailbox message, status update) or MAX_IDLE_WAIT expires as a safety net.
#
# Usage: ./run-agent.sh <agent-name> <role-file> [model]
# Examples:
#   ./run-agent.sh agent-be  FEATURE_ROLE.md claude-sonnet-4-6
#   ./run-agent.sh agent-fe  FEATURE_ROLE.md claude-sonnet-4-6
#   ./run-agent.sh agent-qa  QA_ROLE.md
#   ./run-agent.sh agent-doc DOC_ROLE.md
#
# Per-agent config: ~/agents/<agent-name>/config
#   CONTROL_REPO_URL=git@github.com:ecoba/dsti-cms-control.git
#   WORK_REPO_URL=git@github.com:ecoba/dsti-cms-docs.git      # empty for QA
#   AGENT_DOMAIN=doc                                           # be | fe | full | qa | doc
#   READ_REPOS="git@github.com:ecoba/dsti-cms-api.git git@github.com:ecoba/dsti-cms-web.git"  # optional, read-only

set -u

AGENT_NAME="${1:?Usage: run-agent.sh <agent-name> <role-file> [model]}"
ROLE_FILE="${2:?Provide a role file, e.g. FEATURE_ROLE.md}"
MODEL="${3:-claude-sonnet-4-6}"

AGENT_HOME="$HOME/agents/$AGENT_NAME"
CONFIG="$AGENT_HOME/config"
CONTROL_DIR="$AGENT_HOME/control"
WORK_DIR="$AGENT_HOME/work"
READ_DIR="$AGENT_HOME/read"
LOG_DIR="$AGENT_HOME/logs"
WAKE_CHECK_INTERVAL=30    # seconds between cheap ls-remote checks while idle
MAX_IDLE_WAIT=1800        # safety net: wake anyway after 30 min even if nothing changed
MAX_CONSECUTIVE_FAILS=3

[ -f "$CONFIG" ] || { echo "Missing config: $CONFIG"; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
mkdir -p "$LOG_DIR"

# --- One-time clones ---
if [ ! -d "$CONTROL_DIR/.git" ]; then
  git clone "$CONTROL_REPO_URL" "$CONTROL_DIR" || { echo "control clone failed"; exit 1; }
fi
if [ -n "${WORK_REPO_URL:-}" ] && [ ! -d "$WORK_DIR/.git" ]; then
  git clone "$WORK_REPO_URL" "$WORK_DIR" || { echo "work clone failed"; exit 1; }
fi

# Read-only repos: cloned under read/<repo-name>, pulled each iteration, never pushed
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

# Role name derived from role file (FEATURE_ROLE.md -> feature) for bin/task
AGENT_ROLE=$(basename "$ROLE_FILE" | sed 's/_ROLE.*//' | tr '[:upper:]' '[:lower:]')

# --- Metrics worktree on dedicated 'metrics' branch (keeps main history clean) ---
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

# --- Inject QA credentials (staging only, never committed) ---
if [ -f "$HOME/.cstack-secrets/dsti-qa-user" ]; then
  export QA_USER="$(cat "$HOME/.cstack-secrets/dsti-qa-user")"
  export QA_PASS="$(cat "$HOME/.cstack-secrets/dsti-qa-pass")"
fi

export AGENT_NAME AGENT_DOMAIN AGENT_ROLE CONTROL_DIR WORK_DIR READ_DIR

consecutive_fails=0
echo "[$AGENT_NAME] supervisor v4 — role: $ROLE_FILE, domain: ${AGENT_DOMAIN:-?}, model: $MODEL"
echo "[$AGENT_NAME] control: $CONTROL_DIR  work: ${WORK_REPO_URL:-<none>}  read: ${READ_REPOS:-<none>}"

while true; do
  # Sync everything before each session
  git -C "$CONTROL_DIR" pull --rebase --quiet || true
  [ -d "$WORK_DIR/.git" ] && { git -C "$WORK_DIR" pull --rebase --quiet || true; }
  for rd in "${READ_DIRS[@]:-}"; do
    [ -n "$rd" ] && git -C "$rd" pull --quiet || true
  done

  COMMIT_CTRL=$(git -C "$CONTROL_DIR" rev-parse --short=6 HEAD 2>/dev/null || echo "nogit")
  TS_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  EPOCH_START=$(date +%s)
  RUN_ID="${AGENT_NAME}_$(date +%Y%m%d-%H%M%S)_${COMMIT_CTRL}"
  JSONFILE="$LOG_DIR/${RUN_ID}.json"

  echo "[$AGENT_NAME] iteration start @ control:$COMMIT_CTRL"

  # Build --add-dir flags: control + every read-only repo
  ADD_DIRS=(--add-dir "$CONTROL_DIR")
  for rd in "${READ_DIRS[@]:-}"; do
    [ -n "$rd" ] && ADD_DIRS+=(--add-dir "$rd")
  done

  RUN_CWD="$WORK_DIR"; [ -d "$WORK_DIR/.git" ] || RUN_CWD="$CONTROL_DIR"
  (
    cd "$RUN_CWD" || exit 1
    claude --dangerously-skip-permissions \
           "${ADD_DIRS[@]}" \
           -p "$(cat "$CONTROL_DIR/AGENT_BASE.md" "$CONTROL_DIR/roles/$ROLE_FILE")" \
           --model "$MODEL" \
           --output-format json
  ) > "$JSONFILE" 2> "$LOG_DIR/${RUN_ID}.stderr"
  EXIT_CODE=$?
  EPOCH_END=$(date +%s)
  DURATION=$((EPOCH_END - EPOCH_START))

  # Safety: read-only repos must have no local mutations — hard reset any drift
  for rd in "${READ_DIRS[@]:-}"; do
    [ -n "$rd" ] && git -C "$rd" reset --hard -q HEAD 2>/dev/null && git -C "$rd" clean -fdq 2>/dev/null || true
  done

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
  echo "$METRIC_LINE" >> "$METRICS_FILE"
  git -C "$METRICS_WT" add METRICS.jsonl 2>/dev/null && \
    git -C "$METRICS_WT" commit -qm "metrics(${AGENT_NAME}): ${RUN_ID}" 2>/dev/null && \
    git -C "$METRICS_WT" push -q -u origin metrics 2>/dev/null || \
    { git -C "$METRICS_WT" pull --rebase -q origin metrics 2>/dev/null; git -C "$METRICS_WT" push -q -u origin metrics 2>/dev/null || true; }

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

  # --- Event-driven idle wake (BEAM receive-style: deschedule, wake on control-repo change) ---
  if echo "$METRIC_LINE" | grep -q '"no_work":true'; then
    LAST_SEEN=$(git -C "$CONTROL_DIR" rev-parse HEAD 2>/dev/null || echo "")
    IDLE_START=$(date +%s)
    echo "[$AGENT_NAME] no eligible tasks — descheduled, watching control repo (check every ${WAKE_CHECK_INTERVAL}s, max ${MAX_IDLE_WAIT}s)"
    while true; do
      sleep "$WAKE_CHECK_INTERVAL"
      REMOTE_HEAD=$(git -C "$CONTROL_DIR" ls-remote -q origin HEAD 2>/dev/null | cut -f1)
      if [ -n "$REMOTE_HEAD" ] && [ "$REMOTE_HEAD" != "$LAST_SEEN" ]; then
        echo "[$AGENT_NAME] control repo changed ($REMOTE_HEAD) — waking"
        break
      fi
      IDLE_NOW=$(date +%s)
      if [ $((IDLE_NOW - IDLE_START)) -ge "$MAX_IDLE_WAIT" ]; then
        echo "[$AGENT_NAME] max idle wait reached — waking for safety-net check"
        break
      fi
    done
  fi
done
