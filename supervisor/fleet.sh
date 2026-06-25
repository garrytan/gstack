#!/usr/bin/env bash
# fleet.sh — start, stop, and monitor all agents defined in fleet.conf
#
# Commands:
#   ./fleet.sh start     Start all agents in the background (logs → ~/agents/<name>/logs/)
#   ./fleet.sh stop      Stop all running agents gracefully
#   ./fleet.sh status    Show live status of every agent (running/idle/stopped)
#   ./fleet.sh watch     Live refreshing dashboard — task, duration, last tool (Ctrl-C to exit)
#   ./fleet.sh stream    Real-time event feed — every tool call from every agent as it happens
#   ./fleet.sh logs      Tail all supervisor stdout logs interleaved (Ctrl-C to exit)
#   ./fleet.sh install   Register all agents as launchd (macOS) / systemd (Linux) services
#                        so they start at login and restart on crash — no terminal needed
#   ./fleet.sh uninstall Remove all OS service registrations
#   ./fleet.sh restart   stop + start
#
# Quick start (development):
#   1. Create ~/agents/<agent-name>/config for each agent in fleet.conf
#   2. ./fleet.sh start
#   3. ./fleet.sh status      (check they're running)
#   4. ./fleet.sh logs        (watch live output)
#
# Production (agents survive logout and restart on crash):
#   1. ./fleet.sh install
#   2. Done — agents run as background services. No terminal window needed.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FLEET_CONF="${FLEET_CONF:-$SCRIPT_DIR/fleet.conf}"
SUPERVISOR="$SCRIPT_DIR/run-agent.sh"
PID_DIR="$SCRIPT_DIR/.pids"
OS="$(uname -s)"

# ── Helpers ───────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

read_fleet() {
  # Emits: agent_name role_file model (one line per agent)
  #
  # Optional positional args act as an allowlist — only matching agents are
  # emitted. Lets callers do `./fleet.sh start cms-agent-be cms-agent-qa`
  # instead of starting every agent in fleet.conf.
  #
  # Unknown names (not in fleet.conf) abort with a clear error so a typo
  # never silently expands the fleet you didn't mean to touch.
  [ -f "$FLEET_CONF" ] || die "fleet.conf not found: $FLEET_CONF"

  local -a allow=()
  if [ "$#" -gt 0 ]; then
    allow=("$@")
    # Validate every requested name exists in fleet.conf
    local known_names
    known_names=$(grep -v '^\s*#' "$FLEET_CONF" | grep -v '^\s*$' | awk '{print $1}')
    local n
    for n in "${allow[@]}"; do
      echo "$known_names" | grep -qx "$n" || die "unknown agent: $n (not in $FLEET_CONF)"
    done
  fi

  grep -v '^\s*#' "$FLEET_CONF" | grep -v '^\s*$' | while IFS= read -r line; do
    # shellcheck disable=SC2086
    set -- $line
    local name="$1" role="${2:-FEATURE_ROLE.md}" model="${3:-claude-sonnet-4-6}"
    if [ "${#allow[@]}" -gt 0 ]; then
      local match=0 a
      for a in "${allow[@]}"; do [ "$a" = "$name" ] && match=1 && break; done
      [ "$match" -eq 0 ] && continue
    fi
    echo "$name $role $model"
  done
}

agent_log_dir() { echo "$HOME/agents/$1/logs"; }
agent_presence() { echo "$HOME/agents/$1/control/mailboxes/presence/$1.json"; }

is_running_by_pid() {
  local pid_file="$PID_DIR/$1.pid"
  [ -f "$pid_file" ] || return 1
  local pid; pid=$(cat "$pid_file")
  kill -0 "$pid" 2>/dev/null
}

is_installed() {
  local name="$1"
  case "$OS" in
    Darwin) [ -f "$HOME/Library/LaunchAgents/com.cstack.agent.${name}.plist" ] ;;
    Linux)  [ -f "$HOME/.config/systemd/user/cstack-${name}.service" ] ;;
    *)      return 1 ;;
  esac
}

agent_state() {
  local name="$1"
  local presence; presence=$(agent_presence "$name")

  # Installed as OS service
  if is_installed "$name"; then
    case "$OS" in
      Darwin)
        local svc_status
        svc_status=$(launchctl print "gui/$(id -u)/com.cstack.agent.${name}" 2>/dev/null | grep 'state =' | awk '{print $3}')
        case "$svc_status" in
          running) echo "service:running" ;;
          *)       echo "service:stopped" ;;
        esac
        return
        ;;
      Linux)
        if systemctl --user is-active --quiet "cstack-${name}" 2>/dev/null; then
          echo "service:running"
        else
          echo "service:stopped"
        fi
        return
        ;;
    esac
  fi

  # Background process started by fleet.sh start
  if is_running_by_pid "$name"; then
    # Try to read detailed state from presence file
    if [ -f "$presence" ]; then
      local state ts
      state=$(python3 -c "import json,sys; d=json.load(open('$presence')); print(d.get('state','?'))" 2>/dev/null || echo "?")
      ts=$(python3 -c "import json,sys; d=json.load(open('$presence')); print(d.get('ts',''))" 2>/dev/null || echo "")
      echo "bg:${state}:${ts}"
    else
      echo "bg:starting"
    fi
    return
  fi

  echo "stopped"
}

color_state() {
  local raw="$1"
  case "$raw" in
    service:running|bg:working*)  printf '\033[32m%s\033[0m' "$raw" ;;  # green
    bg:idle*)                     printf '\033[33m%s\033[0m' "$raw" ;;  # yellow
    service:stopped|stopped)      printf '\033[31m%s\033[0m' "$raw" ;;  # red
    *)                            printf '%s' "$raw" ;;
  esac
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_start() {
  [ -f "$SUPERVISOR" ] || die "run-agent.sh not found: $SUPERVISOR"
  mkdir -p "$PID_DIR"

  read_fleet "$@" | while read -r name role model; do
    if is_installed "$name"; then
      echo "[$name] already installed as OS service — use 'fleet.sh install' to manage"
      continue
    fi
    if is_running_by_pid "$name"; then
      echo "[$name] already running (PID $(cat "$PID_DIR/$name.pid"))"
      continue
    fi
    # Also check for orphaned processes not tracked in .pids/ (e.g. started in
    # another terminal or after a stale pid file) — avoids double-launching.
    local existing_pid
    existing_pid=$(pgrep -f "run-agent.sh ${name} " 2>/dev/null | head -1)
    if [ -n "$existing_pid" ]; then
      echo "$existing_pid" > "$PID_DIR/$name.pid"
      echo "[$name] already running (PID $existing_pid, adopted)"
      continue
    fi

    log_dir=$(agent_log_dir "$name")
    mkdir -p "$log_dir"

    # Launch supervisor in background, redirect output to log file
    bash "$SUPERVISOR" "$name" "$role" "$model" \
      >> "$log_dir/stdout.log" 2>> "$log_dir/stderr.log" &
    local pid=$!
    echo "$pid" > "$PID_DIR/$name.pid"
    echo "[$name] started (PID $pid, logs: $log_dir/stdout.log)"
  done
}

cmd_stop() {
  read_fleet "$@" | while read -r name role _model; do
    if is_installed "$name"; then
      case "$OS" in
        Darwin) launchctl stop "com.cstack.agent.${name}" 2>/dev/null && echo "[$name] service stopped" || echo "[$name] not running" ;;
        Linux)  systemctl --user stop "cstack-${name}" 2>/dev/null && echo "[$name] service stopped" || echo "[$name] not running" ;;
      esac
      continue
    fi

    # Kill every run-agent.sh process for this agent — handles duplicates from
    # agents started in multiple terminals outside fleet.sh (not just .pids/).
    # SIGTERM first (lets cleanup trap run), then SIGKILL after 3s for survivors.
    local pid_file="$PID_DIR/$name.pid"
    local tracked_pid=""
    [ -f "$pid_file" ] && tracked_pid=$(cat "$pid_file")

    local all_pids
    all_pids=$(printf '%s\n' $tracked_pid $(pgrep -f "run-agent.sh ${name} " 2>/dev/null) \
      | sort -u | grep -v '^$' | xargs)

    if [ -n "$all_pids" ]; then
      # SIGTERM pass
      for pid in $all_pids; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 3
      # SIGKILL any survivors (catches processes in open terminals or subshells)
      local survivors
      survivors=$(printf '%s\n' $all_pids | while read -r pid; do
        kill -0 "$pid" 2>/dev/null && echo "$pid" || true
      done)
      for pid in $survivors; do
        kill -9 "$pid" 2>/dev/null || true
      done
      local count; count=$(echo "$all_pids" | wc -w | tr -d ' ')
      echo "[$name] stopped ($count process(es) killed)"
    else
      echo "[$name] not running"
    fi
    rm -f "$pid_file"
  done
}

cmd_status() {
  printf '\n%-14s  %-10s  %-8s  %s\n' "AGENT" "MODE" "STATE" "DETAIL"
  printf '%s\n' "------------------------------------------------------------"

  read_fleet | while read -r name role model; do
    local raw; raw=$(agent_state "$name")
    local mode state detail

    case "$raw" in
      service:*)   mode="service"; state="${raw#service:}" ;;
      bg:*:*)      mode="bg";      state=$(echo "$raw" | cut -d: -f2); detail=$(echo "$raw" | cut -d: -f3) ;;
      bg:*)        mode="bg";      state="${raw#bg:}" ;;
      stopped)     mode="—";       state="stopped" ;;
      *)           mode="?";       state="$raw" ;;
    esac

    local log_dir; log_dir=$(agent_log_dir "$name")
    local last_line=""
    [ -f "$log_dir/stdout.log" ] && last_line=$(tail -1 "$log_dir/stdout.log" 2>/dev/null | cut -c1-60 || true)

    printf '%-14s  %-10s  ' "$name" "$mode"
    color_state "$state"
    printf '  %s\n' "${detail:-$last_line}"
  done
  echo ""
}

cmd_logs() {
  trap 'kill 0' EXIT INT TERM

  read_fleet | while read -r name _role _model; do
    local log; log="$(agent_log_dir "$name")/stdout.log"
    mkdir -p "$(dirname "$log")"
    touch "$log"
    tail -f "$log" | sed "s/^/[$name] /" &
  done

  echo "Tailing all agent supervisor logs — Ctrl-C to exit"
  wait
}

cmd_watch() {
  local watch_script="$SCRIPT_DIR/watch.ts"
  if ! command -v bun &>/dev/null; then
    die "bun is required for fleet.sh watch (https://bun.sh)"
  fi
  [ -f "$watch_script" ] || die "watch.ts not found: $watch_script"
  bun run "$watch_script" "$FLEET_CONF" "$HOME/agents"
}

cmd_stream() {
  # Real-time event feed: tail every agent's live-events.jsonl and format each line.
  # Output: [agent-be  12m34s] Bash        git commit -m 'feat(FEAT-001)...'
  trap 'kill 0' EXIT INT TERM

  local started=0
  read_fleet | while read -r name _role _model; do
    local events_file; events_file="$(agent_log_dir "$name")/live-events.jsonl"
    mkdir -p "$(agent_log_dir "$name")"
    touch "$events_file"
    started=$((started + 1))

    tail -f "$events_file" | python3 - "$name" &<<'PYEOF'
import sys, json
agent = sys.argv[1]
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    try:
        ev = json.loads(raw)
    except json.JSONDecodeError:
        continue
    etype   = ev.get("type", "")
    ts      = ev.get("ts", "")[-8:-1] if ev.get("ts") else "--:--:--"  # HH:MM:SS
    task    = ev.get("task") or ev.get("agent", "—")
    if etype == "tool_call":
        tool    = (ev.get("tool") or "").ljust(12)
        summary = ev.get("summary", "")[:60]
        print(f"\033[36m[{agent}]\033[0m {ts}  \033[33m{tool}\033[0m  {summary}", flush=True)
    elif etype == "task_claimed":
        print(f"\033[36m[{agent}]\033[0m {ts}  \033[32m→ claimed {ev.get('task','?')}\033[0m", flush=True)
    elif etype == "session_end":
        dur = ev.get("duration_s", 0)
        m, s = divmod(dur, 60)
        print(f"\033[36m[{agent}]\033[0m {ts}  \033[2msession end — {m}m{s}s  task={task}\033[0m", flush=True)
PYEOF

  done

  echo "Streaming tool-call events from all agents — Ctrl-C to exit"
  wait
}

cmd_install() {
  [ -f "$SCRIPT_DIR/install.sh" ] || die "install.sh not found: $SCRIPT_DIR/install.sh"
  read_fleet "$@" | while read -r name role model; do
    bash "$SCRIPT_DIR/install.sh" "$name" "$role" "$model"
  done
}

cmd_uninstall() {
  read_fleet "$@" | while read -r name _role _model; do
    case "$OS" in
      Darwin)
        local label="com.cstack.agent.${name}"
        local plist="$HOME/Library/LaunchAgents/${label}.plist"
        launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
        rm -f "$plist"
        echo "[$name] uninstalled"
        ;;
      Linux)
        systemctl --user disable --now "cstack-${name}" 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/cstack-${name}.service"
        systemctl --user daemon-reload
        echo "[$name] uninstalled"
        ;;
    esac
  done
}

# ── Entry point ───────────────────────────────────────────────────────────────

CMD="${1:-help}"
shift || true   # rest of argv ($@) is now the optional agent-name allowlist
case "$CMD" in
  start)     cmd_start "$@" ;;
  stop)      cmd_stop "$@" ;;
  status)    cmd_status ;;
  watch)     cmd_watch ;;
  stream)    cmd_stream ;;
  logs)      cmd_logs ;;
  install)   cmd_install "$@" ;;
  uninstall) cmd_uninstall "$@" ;;
  restart)   cmd_stop "$@"; sleep 1; cmd_start "$@" ;;
  help|--help|-h)
    echo "Usage: fleet.sh <command> [agent-name...]"
    echo ""
    echo "  start [names...]      Start agents in the background (all if no names given)"
    echo "  stop  [names...]      Stop agents (all if no names given)"
    echo "  status                Show live status of every agent"
    echo "  watch                 Live dashboard — task, duration, last tool (Ctrl-C)"
    echo "  stream                Real-time tool-call feed from all agents (Ctrl-C)"
    echo "  logs                  Tail all supervisor stdout logs (Ctrl-C)"
    echo "  install [names...]    Register as OS services (survive logout, auto-restart)"
    echo "  uninstall [names...]  Remove OS service registrations"
    echo "  restart [names...]    stop + start"
    echo ""
    echo "Examples:"
    echo "  ./fleet.sh start cms-agent-be cms-agent-qa   # start just these two"
    echo "  ./fleet.sh stop agent-doc                    # stop one specific agent"
    echo "  ./fleet.sh install cms-agent-be              # install one as a service"
    echo "  ./fleet.sh start                             # start every agent in fleet.conf"
    echo ""
    echo "Agents defined in: $FLEET_CONF"
    ;;
  *) die "Unknown command: $CMD. Run './fleet.sh help' for usage." ;;
esac
