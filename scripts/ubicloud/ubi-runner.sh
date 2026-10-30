#!/usr/bin/env bash
# ubi-runner — run a command on an ephemeral Ubicloud VM.
#
#   UBICLOUD_API_KEY=... scripts/ubicloud/ubi-runner.sh run --setup S.sh -- 'make test'
#
# UBICLOUD_API_TOKEN is accepted as an alias for UBICLOUD_API_KEY. SSH
# connections are multiplexed per VM, and `pack` / `unpack` upload one prebuilt
# checkout tarball to many VMs. This is the repo copy the user-scope Capy
# `ubicloud` skill and gbrain's scripts/ubicloud/ubi-runner.sh are kept in sync
# with (plan E2); `bun run test:ubicloud` drives it through test-free.sh.
#
# Scratch record: every VM this machine creates is appended to a VM-id file
# (UBI_VM_RECORD; default ~/.capy/work/ubi-runner/vms.tsv when ~/.capy/work
# exists, else $STATE_ROOT/vms.tsv) as `name location owner created_at pid`,
# and removed once `down` confirms it gone. A resumed Capy thread reads that
# file to find VMs an earlier turn left behind (docs/TESTING_INTERNALS.md,
# "Resuming after a wake").
#
# Creates a VM (standard-16 by default), streams the checkout to it (tracked +
# untracked-unignored files + .git, so uncommitted edits are included), runs an
# optional setup script and the command, copies requested artifacts back, and
# destroys the VM on every exit path. Exits with the command's status.
# Needs only bash, curl, python3, ssh, ssh-keygen, and tar locally, so it works
# from dev boxes, containers, and cloud sandboxes.
#
# Ownership: VMs are named ubirun-<owner>-<epoch>-<suffix>-t<hours>. <owner> is UBI_OWNER
# (lowercased, letters and digits only, at most 12 characters, starting with a
# letter). `up`, `run` and `verify` refuse without it (UBI_OWNER_REQUIRED), so
# every VM names whoever can be asked about it; read-only commands fall back to a
# per-machine id kept in $STATE_ROOT/owner-id. Ubicloud names allow 63 characters
# of [a-z0-9-], so a full name stays under 45.
#
# Teardown: `up` records each VM's state (location, create status) before it
# sends the create request, and `down` destroys and polls until the VM is
# confirmed gone or provably never existed, waiting out a create that may still
# be in flight. An interrupted `up` or `run` (EXIT, INT, TERM, HUP, QUIT) runs
# that `down`; further signals are ignored until it finishes. A create refused
# for vCPU quota prints the project's usage per owner.
#
# The owner-age sweep is off by default (the TTL reap below always runs). With UBI_GC_HOURS set to a positive
# number, every `up` first destroys this owner's VMs older than that; `gc HOURS`
# runs the same sweep on demand. Neither ever touches another owner's VMs.
#
# TTL and reaper: a name this script generates ends in -t<hours> (UBI_TTL_HOURS,
# 1-999, default 3), the creator's own declaration of how long the VM may live.
# `reap` destroys every VM in the project whose TTL expired more than ten
# minutes ago, whichever owner made it, and this owner's own ubirun-<owner>-*
# names with no TTL once they are UBI_LEGACY_HOURS old (default 4; another
# owner's or an untagged TTL-less VM is never reaped); every `up` runs it first (UBI_REAP=0 skips it), so a runner
# killed by a sleeping machine leaves nothing behind for longer than its TTL.
# Names outside the ubirun- prefix are never reaped.
#
# Leftover line: `run` and `verify` end with
#   UBICLOUD: left=<0|1|unknown> owner=<owner> vm=<name> others=<n>
# after teardown: left counts this invocation's own VM, checked against the
# project's VM list, and others counts this owner's other VMs (information only).
# A left other than 0 turns a passing command into exit 1; `run --keep` reports
# its live VM as left=1 kept=1 and keeps its exit status. With UBI_LEFT_FILE set,
# the line is also appended to that file, out of reach of the command's output.
#
# Quota preflight: when the project's vCPU ceiling is known (UBI_QUOTA_VCPUS, or
# the maximum a refusal printed, cached in $STATE_ROOT/quota-max), `up` adds the
# size's vCPUs to the project's running VMs and refuses before any create when
# that exceeds it; UBI_QUOTA_WAIT=<seconds> waits for room instead.
#
# Watchdog: `run`, `verify` and `ssh NAME COMMAND` stream the remote output
# through a watchdog that logs a heartbeat every UBI_HEARTBEAT seconds (300)
# and kills a command silent for UBI_IDLE_TIMEOUT seconds (1800) or older than
# UBI_RUN_TIMEOUT seconds (0, unlimited), exiting 124 with the last 40 lines,
# so a hung verify fails fast instead of holding the VM until its TTL.
#
# `verify` is the one entry point for a repository's full remote verify: it
# reads .gstack/ubicloud.json (setup, command, size, location, env, pass, pull)
# and runs it through `run`, so lanes share one committed definition instead of
# per-lane wrappers.
set -euo pipefail
# Keep heredoc bodies on temp files, not the pipe window (test/heredoc-pipe-deadlock.test.ts).
BASH_COMPAT=50

API="${UBICLOUD_API_URL:-https://api.ubicloud.com}"
STATE_ROOT="${UBI_RUNNER_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ubi-runner}"
DEFAULT_SIZE="${UBI_SIZE:-standard-16}"
DEFAULT_LOCATION="${UBI_LOCATION:-eu-central-h1}"
GC_HOURS="${UBI_GC_HOURS:-0}"
API_TIMEOUT="${UBI_API_TIMEOUT:-120}"
CREATE_GRACE="${UBI_CREATE_GRACE:-180}"
DOWN_TIMEOUT="${UBI_DOWN_TIMEOUT:-900}"
POLL="${UBI_POLL_SECONDS:-5}"
ALLOWED_STORAGE="${UBI_ALLOWED_STORAGE:-320 640}"
TTL_HOURS="${UBI_TTL_HOURS:-3}"
LEGACY_HOURS="${UBI_LEGACY_HOURS:-4}"
REAP="${UBI_REAP:-1}"
REAP_GRACE=600
IDLE_TIMEOUT="${UBI_IDLE_TIMEOUT:-1800}"
RUN_TIMEOUT="${UBI_RUN_TIMEOUT:-0}"
HEARTBEAT="${UBI_HEARTBEAT:-300}"
QUOTA_VCPUS="${UBI_QUOTA_VCPUS:-}"
QUOTA_WAIT="${UBI_QUOTA_WAIT:-0}"
PREFIX="ubirun"
if [ -n "${UBI_VM_RECORD:-}" ]; then VM_RECORD="$UBI_VM_RECORD"
elif [ -d "$HOME/.capy/work" ]; then VM_RECORD="$HOME/.capy/work/ubi-runner/vms.tsv"
else VM_RECORD="$STATE_ROOT/vms.tsv"; fi

die() { echo "ubi-runner: $*" >&2; exit 1; }
log() { echo "ubi-runner: $*" >&2; }

for bin in curl python3 ssh ssh-keygen tar; do
  command -v "$bin" >/dev/null || die "$bin is required"
done
UBICLOUD_API_KEY="${UBICLOUD_API_KEY:-${UBICLOUD_API_TOKEN:-}}"
[[ "$GC_HOURS" =~ ^[0-9]+$ ]] || die "UBI_GC_HOURS must be a whole number of hours (unset or 0 disables the sweep)"
for v in IDLE_TIMEOUT RUN_TIMEOUT HEARTBEAT QUOTA_WAIT; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || die "UBI_$v must be a whole number of seconds (0 disables it)"
done
[ -z "$QUOTA_VCPUS" ] || [[ "$QUOTA_VCPUS" =~ ^[0-9]+$ ]] || die "UBI_QUOTA_VCPUS must be a whole number of vCPUs"

owner_id() {
  local raw=${UBI_OWNER:-} file="$STATE_ROOT/owner-id" tmp
  if [ -z "$raw" ]; then
    if [ ! -s "$file" ]; then
      mkdir -p "$STATE_ROOT"
      tmp="$file.$$"
      echo "m$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$tmp"
      mv -n "$tmp" "$file"
      rm -f "$tmp"
    fi
    raw=$(cat "$file")
  fi
  raw=$(printf %s "$raw" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')
  [ -n "$raw" ] || die "UBI_OWNER must contain letters or digits"
  [[ "$raw" =~ ^[a-z] ]] || raw="u$raw"
  echo "${raw:0:12}"
}
OWNER=$(owner_id)

# require_owner: up, run and verify create VMs, and a VM must name its owner
# and carry a TTL. Only creates check UBI_TTL_HOURS, so an old value never
# blocks down, reap or list.
require_owner() {
  [ -n "${UBI_OWNER:-}" ] || die "UBI_OWNER is not set: every VM must carry its owner; export UBI_OWNER=<your thread or session code> (for example gsta164) and rerun (UBI_OWNER_REQUIRED)"
  [[ "$TTL_HOURS" =~ ^[1-9][0-9]{0,2}$ ]] || die "UBI_TTL_HOURS must be a whole number of hours from 1 to 999 with no leading zero (every VM carries a TTL; set it above your longest run)"
}

# leftover FIELDS...: print the UBICLOUD: leftover line, and append it to
# UBI_LEFT_FILE when set, so a caller can read it apart from the command's output.
leftover() {
  echo "UBICLOUD: $*" >&2
  [ -z "${UBI_LEFT_FILE:-}" ] || echo "UBICLOUD: $*" >>"$UBI_LEFT_FILE"
}

# api OUT ARGS...: send one Ubicloud CLI command, write the body to OUT, and
# print the HTTP status (000 when no response arrived).
api() {
  local out=$1 code
  shift
  code=$(python3 -c 'import json,sys; print(json.dumps({"argv": sys.argv[1:]}))' "$@" \
    | curl -sS -o "$out" -w '%{http_code}' --max-time "$API_TIMEOUT" -X POST \
        -H "Authorization: Bearer $UBICLOUD_API_KEY" \
        -H 'Accept: text/plain' -H 'Content-Type: application/json' \
        -H 'X-Ubi-Version: 1.0.0' --data @- "$API/cli") || true
  echo "${code:-000}"
}

cli() {
  local out code
  out=$(mktemp)
  code=$(api "$out" "$@")
  if [ "$code" = 000 ]; then
    rm -f "$out"
    die "request failed: ubi $*"
  fi
  if [ "$code" != 200 ]; then
    cat "$out" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

state_dir() { echo "$STATE_ROOT/$1"; }

load() {
  local dir
  dir=$(state_dir "$1")
  [ -f "$dir/env" ] || die "no local state for VM '$1' (created on another machine?)"
  # shellcheck disable=SC1091
  . "$dir/env"
  KEY="$dir/key"
}

ssh_opts() {
  echo -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=10 \
    -o ControlMaster=auto -o "ControlPath=$(dirname "$KEY")/ctl" -o ControlPersist=300
}

# Ubuntu's default umask (002) leaves new directories group-writable, which
# permission-checking code under test rejects; every remote command uses 022.
remote() {
  local name=$1; shift
  load "$name"
  # shellcheck disable=SC2046
  ssh $(ssh_opts) "ubi@$IP" "umask 022; $*"
}

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# sq STRING: STRING as one single-quoted shell word.
sq() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }

# remote_cancel NAME SIDFILE: end the session a watched command started on the
# VM (its leader pid is in SIDFILE there), bounded to 20 seconds. Killing the
# local ssh client alone leaves a silent remote command running until it next
# writes to the closed channel.
remote_cancel() {
  local name=$1 sidf=$2 cpid i=0
  remote "$name" "sid=\$(cat $sidf 2>/dev/null); rm -f $sidf; [ -z \"\$sid\" ] || { pkill -TERM -s \"\$sid\"; sleep 2; pkill -KILL -s \"\$sid\"; }; true" >/dev/null 2>&1 </dev/null &
  cpid=$!
  while kill -0 "$cpid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 1; i=$(( i + 1 )); done
  kill "$cpid" 2>/dev/null || true
  wait "$cpid" 2>/dev/null || true
}

# watched NAME PHASE COMMAND: run COMMAND on the VM, streaming its output and
# keeping a copy of both streams in the VM's state dir, with a heartbeat every HEARTBEAT
# seconds and a watchdog that kills it after IDLE_TIMEOUT seconds of silence or
# RUN_TIMEOUT seconds in total: exit 124, reason and the last 40 lines on
# stderr. The ssh runs in its own session (python3's setsid) so the watchdog
# kills it and anything it started, not just the shell that launched it; on
# the VM the command runs in its own session too (setsid where the image has
# it), whose leader pid is written to ~/.ubirun-PHASE-<runner pid>.sid so
# remote_cancel can end it when the client is killed.
watched() {
  local name=$1 phase=$2 cmd=$3 out pid rc=0 start now last_beat idle elapsed why="" old_traps inner sidf
  sidf="~/.ubirun-$phase-$$.sid"
  load "$name"
  out="$(state_dir "$name")/$phase.log"
  : >"$out"
  inner=$(sq "printf %s \$\$ >$sidf; $cmd")
  # The sid file outlives the command on purpose: a background child it left
  # behind keeps the ssh channel open after the wrapper exits, and remote_cancel
  # still needs the session id to end it. remote_cancel removes the file.
  cmd="if command -v setsid >/dev/null 2>&1; then setsid -w bash -c $inner; else bash -c $inner; fi"
  # The caller's stdin is handed to the background ssh explicitly (a background
  # job in a non-interactive shell would otherwise read /dev/null), so piped
  # input reaches the remote command as it did before the watchdog.
  exec 3<&0
  # shellcheck disable=SC2046
  ( exec python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      ssh $(ssh_opts) "ubi@$IP" "umask 022; $cmd" ) <&3 > >(tee -a "$out") 2> >(tee -a "$out" >&2) &
  pid=$!
  exec 3<&-
  # A signal to this process takes the ssh session down with it, so Ctrl-C on
  # `ssh NAME COMMAND` leaves no orphaned client behind.
  old_traps=$(trap -p INT TERM)
  trap 'kill -TERM -- "-$pid" 2>/dev/null; exit 130' INT TERM
  start=$(date +%s)
  last_beat=$start
  while :; do
    sleep 1
    kill -0 "$pid" 2>/dev/null || break
    now=$(date +%s)
    elapsed=$(( now - start ))
    idle=$(( now - $(mtime "$out") ))
    if [ "$IDLE_TIMEOUT" -gt 0 ] && [ "$idle" -ge "$IDLE_TIMEOUT" ]; then
      why="printed nothing for ${idle}s (UBI_IDLE_TIMEOUT=$IDLE_TIMEOUT)"
    elif [ "$RUN_TIMEOUT" -gt 0 ] && [ "$elapsed" -ge "$RUN_TIMEOUT" ]; then
      why="ran ${elapsed}s (UBI_RUN_TIMEOUT=$RUN_TIMEOUT)"
    fi
    if [ -n "$why" ]; then
      # The command may have finished while the clock was read; a finished
      # command is never reported as a timeout.
      kill -0 "$pid" 2>/dev/null || break
      log "watchdog: $phase $why; killing it. Last output:"
      tail -n 40 "$out" >&2
      kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || rc=$?
      trap - INT TERM; eval "$old_traps"
      # A command killed by the watchdog never exits 0; a 0 here means it
      # finished in the instant before the kill, and that result stands.
      if [ "$rc" -eq 0 ]; then
        log "watchdog: $phase finished before it could be killed; its exit 0 stands"
        return 0
      fi
      remote_cancel "$name" "$sidf"
      return 124
    fi
    if [ "$HEARTBEAT" -gt 0 ] && [ $(( now - last_beat )) -ge "$HEARTBEAT" ]; then
      log "heartbeat: $phase ${elapsed}s elapsed, last output ${idle}s ago"
      last_beat=$now
    fi
  done
  wait "$pid" || rc=$?
  trap - INT TERM; eval "$old_traps"
  return "$rc"
}

# vm_rows: "location name owner expires created" for every VM in the project;
# owner is "-" for untagged ubirun-<epoch>-* names and "." for VMs this runner
# did not name; expires is the epoch the name's -t<hours> TTL ends at, or "-";
# created is the name's epoch, or "-".
vm_rows() {
  local loc name owner created expires
  cli vm list -N -f location,name | while read -r loc name; do
    owner=. created="" expires=-
    if [[ "$name" =~ ^${PREFIX}-([a-z][a-z0-9]{0,11})-([0-9]{10})- ]]; then
      owner=${BASH_REMATCH[1]} created=${BASH_REMATCH[2]}
    elif [[ "$name" =~ ^${PREFIX}-([0-9]{10})- ]]; then
      owner=- created=${BASH_REMATCH[1]}
    fi
    if [ -n "$created" ] && [[ "$name" =~ -t([0-9]{1,3})$ ]]; then
      expires=$(( 10#$created + 10#${BASH_REMATCH[1]} * 3600 ))
    fi
    echo "$loc $name $owner $expires ${created:--}"
  done
}

# reap: destroy every VM whose name carries a TTL that ended more than
# REAP_GRACE seconds ago, whichever owner created it (the TTL is that owner's
# own declaration), and the caller's own TTL-less ubirun-<UBI_OWNER>-* names at
# least LEGACY_HOURS old. Another owner's TTL-less VM, an untagged one, and names
# outside the prefix are never touched: only a TTL lets reap judge another lane's VM.
cmd_reap() {
  local now rows loc name owner expires created n=0 failed=0
  [[ "$LEGACY_HOURS" =~ ^[1-9][0-9]{0,3}$ ]] || die "UBI_LEGACY_HOURS must be a whole number of hours from 1 to 9999 with no leading zero (how old a TTL-less ubirun-* VM must be before reap destroys it)"
  now=$(date +%s)
  rows=$(vm_rows) || { log "reap: could not list the project's VMs; nothing destroyed"; return 1; }
  while read -r loc name owner expires created; do
    [ -n "$name" ] || continue
    if [ "$expires" != - ]; then
      [ "$now" -ge $(( expires + REAP_GRACE )) ] || continue
      log "reaping expired $loc/$name (owner $owner; its TTL ended $(( (now - expires) / 60 )) min ago)"
    else
      [ -n "${UBI_OWNER:-}" ] && [ "$owner" = "$OWNER" ] && [ "$created" != - ] || continue
      [ $(( now - 10#$created )) -ge $(( LEGACY_HOURS * 3600 )) ] || continue
      log "reaping TTL-less $loc/$name (owner $owner; $(( (now - 10#$created) / 3600 ))h old, legacy sweep at ${LEGACY_HOURS}h)"
    fi
    n=$(( n + 1 ))
    cmd_down "$name" -l "$loc" || { failed=$(( failed + 1 )); log "failed to reap $loc/$name"; }
  done <<<"$rows"
  [ "$n" -gt 0 ] || log "reap: no expired VMs"
  [ "$failed" -eq 0 ] || { log "reap: $failed of $n expired VMs could not be destroyed"; return 1; }
}

cmd_gc() {
  local hours=${1:-$GC_HOURS} now loc name owner
  [[ "$hours" =~ ^[0-9]+$ ]] || die "gc: HOURS must be a whole number (or set UBI_GC_HOURS)"
  if [ "$hours" -eq 0 ]; then log "gc: no sweep (give HOURS > 0 or set UBI_GC_HOURS); nothing listed, nothing destroyed"; return 0; fi
  now=$(date +%s)
  vm_rows | while read -r loc name owner _; do
    [ "$owner" = "$OWNER" ] || continue
    [[ "$name" =~ -([0-9]{10})- ]] || continue
    if [ $(( (now - BASH_REMATCH[1]) / 3600 )) -ge "$hours" ]; then
      log "destroying stale $loc/$name (owner $OWNER, older than ${hours}h)"
      cmd_down "$name" -l "$loc" || log "failed to destroy $loc/$name"
    fi
  done
}

cmd_list() {
  case ${1:-} in
    "") cli vm list ;;
    --mine) vm_rows | awk -v o="$OWNER" '$3==o {print $1 "  " $2}' ;;
    *) die "list: unknown option $1 (use --mine)" ;;
  esac
}

# usage: VMs and vCPUs per owner, from each VM's size (standard-16 = 16 vCPUs).
cmd_usage() {
  local tmp loc name owner i=0
  tmp=$(mktemp -d)
  while read -r loc name owner _; do
    i=$(( i + 1 ))
    cli vm "$loc/$name" show 2>/dev/null | sed -n "s/^size: /$owner /p" >"$tmp/$i" &
    [ $(( i % 8 )) -ne 0 ] || wait
  done < <(vm_rows)
  wait
  cat "$tmp"/* 2>/dev/null | awk -v me="$OWNER" '
    { n = $2; sub(/^.*-/, "", n); o = $1 == "-" ? "(untagged)" : $1 == "." ? "(other)" : $1
      vms[o]++; cpu[o] += n; total += n; count++ }
    END {
      printf "%-14s %4s %6s\n", "OWNER", "VMS", "VCPUS"
      for (o in cpu) printf "%-14s %4d %6d%s\n", o, vms[o], cpu[o], o == me ? "  (you)" : "" | "sort -k3,3nr"
      close("sort -k3,3nr")
      printf "%-14s %4d %6d\n", "total", count, total
    }'
  rm -rf "$tmp"
}

write_state() {
  printf 'NAME=%q\nLOCATION=%q\nSIZE=%q\nIP=%q\nCREATED=%q\nCREATE_AT=%q\nCREATE_PID=%q\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$$" >"$(state_dir "$1")/env"
}

# record_vm NAME LOCATION: append to the scratch VM-id file (record-before-create).
record_vm() {
  mkdir -p "$(dirname "$VM_RECORD")" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$OWNER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" >>"$VM_RECORD"
}

# forget_vm NAME: drop the VM from the scratch file once it is confirmed gone.
forget_vm() {
  [ -f "$VM_RECORD" ] || return 0
  local tmp="$VM_RECORD.$$"
  awk -F'\t' -v n="$1" '$1!=n' "$VM_RECORD" >"$tmp" && mv "$tmp" "$VM_RECORD"
}

# records: print the scratch file (VMs this machine created and has not confirmed gone).
cmd_records() {
  echo "record: $VM_RECORD"
  [ -s "$VM_RECORD" ] || { echo "(no VMs recorded)"; return 0; }
  printf '%-40s %-14s %-12s %-20s %s\n' NAME LOCATION OWNER CREATED_AT PID
  awk -F'\t' '{ printf "%-40s %-14s %-12s %-20s %s\n", $1, $2, $3, $4, $5 }' "$VM_RECORD"
}

new_name() {
  echo "$PREFIX-$OWNER-$(date +%s)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')-t$TTL_HOURS"
}

# vcpus SIZE: the vCPU count a Ubicloud size name carries (standard-16 -> 16).
vcpus() { [[ "$1" =~ -([0-9]+)$ ]] && echo "${BASH_REMATCH[1]}"; }

# quota_preflight LOCATION NAME SIZE: refuse (or wait UBI_QUOTA_WAIT seconds)
# before the create request when the project's running VMs plus this size
# exceed the known vCPU ceiling. The ceiling comes from UBI_QUOTA_VCPUS or the
# maximum the last refusal printed; without either the API's own refusal rules.
QUOTA_CACHE_MAX_AGE=86400
quota_preflight() {
  local location=$1 name=$2 size=$3 need max used remaining step source="UBI_QUOTA_VCPUS" cache="$STATE_ROOT/quota-max"
  need=$(vcpus "$size") || return 0
  max=$QUOTA_VCPUS
  if [ -z "$max" ] && [ -f "$cache" ]; then
    # A refusal's maximum is remembered for a day: after that (a raised quota,
    # another project's key) the API's own answer decides again.
    if [ $(( $(date +%s) - $(mtime "$cache") )) -lt "$QUOTA_CACHE_MAX_AGE" ]; then
      max=$(cat "$cache" 2>/dev/null || true); source="the last refusal, cached in $cache"
    else
      rm -f "$cache"
    fi
  fi
  [[ "$max" =~ ^[0-9]+$ ]] || return 0
  # The budget counts seconds spent waiting for room, not the usage calls
  # between them: a slow first usage read must not shave the printed budget.
  remaining=$QUOTA_WAIT
  while :; do
    used=$(cmd_usage 2>/dev/null | awk '$1=="total" {print $3}')
    [[ "$used" =~ ^[0-9]+$ ]] || return 0
    [ $(( used + need )) -gt "$max" ] || return 0
    if [ "$remaining" -le 0 ]; then
      log "quota preflight refused $location/$name ($size): it needs $need vCPUs and the project's VMs already use $used of $max (ceiling from $source; other usage such as managed runners counts on top)"
      cmd_usage >&2 || true
      die "create refused before any request: vCPU quota exhausted (quota full); wait for running VMs to finish (UBI_QUOTA_WAIT=<seconds> waits here), run $0 reap, use a smaller size, or set UBI_QUOTA_VCPUS to the project's real ceiling"
    fi
    log "quota: $used of $max vCPUs in use and $need needed; waiting up to ${remaining}s more for room"
    step=$(( remaining < 30 ? remaining : 30 ))
    sleep "$step"
    remaining=$(( remaining - step ))
  done
}

valid_name() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; }

# check_storage GIB: Ubicloud accepts only these disk sizes; refuse before any API call.
check_storage() {
  case " $ALLOWED_STORAGE " in
    *" $1 "*) [ -n "$1" ] && return 0 ;;
  esac
  die "invalid storage '$1' GiB (allowed: $ALLOWED_STORAGE; set UBI_ALLOWED_STORAGE when Ubicloud adds sizes)"
}

UP_NAME=""
UP_READY=""
cmd_up() {
  require_owner
  local size=$DEFAULT_SIZE location=$DEFAULT_LOCATION name="" storage="" image=ubuntu-noble
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size) size=$2; shift 2 ;;
      -l|--location) location=$2; shift 2 ;;
      -n|--name) name=$2; shift 2 ;;
      -S|--storage) check_storage "$2"; storage=$2; shift 2 ;;
      -b|--image) image=$2; shift 2 ;;
      *) die "up: unknown option $1" ;;
    esac
  done
  [ -n "$name" ] || name=$(new_name)
  valid_name "$name" || die "invalid VM name '$name' (Ubicloud allows 1-63 of a-z, 0-9 and '-', starting and ending with a letter or digit)"
  if [ "$REAP" != 0 ]; then
    cmd_reap || log "reap failed; continuing"
  fi
  if [ "$GC_HOURS" -gt 0 ]; then
    cmd_gc "$GC_HOURS" || log "stale-VM cleanup failed; continuing"
  fi
  quota_preflight "$location" "$name" "$size"

  local dir create_at
  dir=$(state_dir "$name")
  mkdir -p "$dir"
  chmod 700 "$dir"
  ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$dir/key"

  local args=(vm "$location/$name" create -s "$size" -b "$image")
  [ -z "$storage" ] || args+=(-S "$storage")
  args+=("$(cat "$dir/key.pub")")
  create_at=$(date +%s)
  write_state "$name" "$location" "$size" "" unknown "$create_at"
  record_vm "$name" "$location"
  UP_NAME=$name
  log "creating $location/$name ($size)"
  # Hold signals until the create answer is recorded, so teardown knows
  # whether the VM exists instead of waiting out UBI_CREATE_GRACE.
  local interrupted="" created=yes refusal need used max
  trap 'interrupted=1' INT TERM HUP QUIT
  cli "${args[@]}" >/dev/null 2>"$dir/create.err" || created=no
  write_state "$name" "$location" "$size" "" "$created" "$create_at"
  trap 'exit 130' INT TERM HUP QUIT
  [ -z "$interrupted" ] || exit 130
  if [ "$created" = no ]; then
    refusal=$(sed -n 's/.*Requested vCPU count: \([0-9]*\), currently used vCPU count: \([0-9]*\), maximum allowed vCPU count: \([0-9]*\).*/\1 \2 \3/p' "$dir/create.err")
    if [ -z "$refusal" ]; then
      cat "$dir/create.err" >&2
      die "create failed"
    fi
    read -r need used max <<<"$refusal"
    echo "$max" >"$STATE_ROOT/quota-max"
    log "quota refused $location/$name ($size): it needs $need vCPUs and the project already uses $used of $max"
    log "VMs in the project by owner (the rest of the used count is other usage, such as managed GitHub runners):"
    cmd_usage >&2 || true
    die "create failed: vCPU quota exhausted; wait for running VMs to finish, or use fewer or smaller VMs (ci:ubicloud --vms N)"
  fi

  local deadline=$(( $(date +%s) + 600 )) show state ip
  while :; do
    show=$(cli vm "$location/$name" show 2>/dev/null || true)
    state=$(sed -n 's/^state: //p' <<<"$show")
    ip=$(sed -n 's/^ip4: //p' <<<"$show")
    [ "$state" = running ] && [ -n "$ip" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || die "VM did not reach running in 10 minutes (last state: ${state:-unknown})"
    sleep "$POLL"
  done
  write_state "$name" "$location" "$size" "$ip" yes "$create_at"

  load "$name"
  deadline=$(( $(date +%s) + 300 ))
  # shellcheck disable=SC2046
  until ssh $(ssh_opts) "ubi@$IP" true 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || die "SSH did not come up on $IP"
    sleep "$POLL"
  done
  remote "$name" 'cloud-init status --wait >/dev/null 2>&1 || true'
  UP_READY=1
  log "ready: $name ($IP)"
  echo "$name"
}

# down NAME [-l LOCATION]: destroy NAME and return 0 only once it is confirmed
# gone or never existed. While this machine's create request for NAME may
# still be in flight (its `up` process is alive, or the create was sent less
# than UBI_CREATE_GRACE seconds ago with no answer), "not found" is not final.
cmd_down() {
  local name=${1:-} loc="" dir
  [ -n "$name" ] || die "down: missing NAME"
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      -l|--location) loc=$2; shift 2 ;;
      *) die "down: unknown option $1" ;;
    esac
  done
  valid_name "$name" || die "invalid VM name '$name'"
  dir=$(state_dir "$name")
  local CREATED=none CREATE_AT=0 CREATE_PID="" IP="" LOCATION="" KEY=""
  if [ -f "$dir/env" ]; then
    load "$name"
    loc=$LOCATION
    if [ -S "$dir/ctl" ] && [ -n "$IP" ]; then
      # shellcheck disable=SC2046
      ssh $(ssh_opts) -O exit "ubi@$IP" >/dev/null 2>&1 || true
    fi
  fi

  local deadline=$(( $(date +%s) + DOWN_TIMEOUT )) seen=0 asked=0 out code now
  out=$(mktemp)
  while :; do
    now=$(date +%s)
    if [ -z "$loc" ]; then
      loc=$(vm_rows 2>/dev/null | awk -v n="$name" '$2==n {print $1}') || loc=""
      code=404
      [ -z "$loc" ] || code=$(api "$out" vm "$loc/$name" show)
    else
      code=$(api "$out" vm "$loc/$name" show)
    fi
    if [ "$code" = 200 ]; then
      seen=1
      if [ $(( now - asked )) -ge 60 ]; then
        code=$(api "$out" vm "$loc/$name" destroy -f)
        if [ "$code" != 200 ]; then
          cat "$out" >&2
          rm -f "$out"
          log "FAILED to destroy $loc/$name (HTTP $code); retry: $0 down $name"
          return 1
        fi
        asked=$now
        log "destroy requested: $loc/$name"
      fi
    elif [ "$code" = 404 ]; then
      if [ "$seen" = 1 ] || [ "$CREATED" != unknown ] || { [ $(( now - CREATE_AT )) -ge "$CREATE_GRACE" ] \
        && { [ "$CREATE_PID" = "$$" ] || ! kill -0 "$CREATE_PID" 2>/dev/null; }; }; then
        rm -f "$out"
        rm -rf "$dir"
        forget_vm "$name"
        if [ "$seen" = 1 ]; then log "destroyed ${loc:-?}/$name"; else log "gone: ${loc:-?}/$name (never existed or already destroyed)"; fi
        return 0
      fi
      log "waiting for an in-flight create of $name to resolve"
    fi
    if [ "$now" -ge "$deadline" ]; then
      rm -f "$out"
      log "WARNING: could not confirm ${loc:-?}/$name is gone after ${DOWN_TIMEOUT}s; rerun: $0 down $name"
      return 1
    fi
    sleep "$POLL"
  done
}

# pack SRC: write a gzipped checkout tarball to stdout (tracked + untracked
# files that are not ignored, plus a .git snapshot; a non-git directory is
# taken whole). The live .git is never tarred: another process running git in
# the checkout (a review subagent's diff, a trial merge's worktree add) writes
# index.lock, packed-refs and objects while tar reads, and GNU tar exits 1
# on a file that changed under it (GSTA-121's PREGATE_REMOTE_INFRA). Instead
# the refs are fetched into a fresh repository through git's own transport,
# which reads a consistent view, the remote.* config is replayed so
# origin/<base> still resolves, and the index is copied (git writes it
# atomically through a rename). A linked worktree's .git is a one-line
# pointer into the main repository, useless on the VM; the same snapshot
# replaces it, on the worktree's own branch and index. Not carried: submodule
# repositories (.git/modules) and a partial clone's promisor (the fetch pulls
# every missing blob first); gstack has neither.
cmd_pack() {
  local src tmp gitdir branch head entry
  src=$(cd "${1:-.}" && pwd)
  if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    head=$(git -C "$src" rev-parse --verify -q HEAD) || die "pack: $src has no commits; the VM needs a HEAD to fingerprint"
    branch=$(git -C "$src" symbolic-ref -q --short HEAD || true)
    tmp=$(mktemp -d)
    # The path is baked in: a set -e failure unwinds the function before the trap runs, and a local $tmp is unset there.
    trap "rm -rf $(printf %q "$tmp")" EXIT
    # No template hooks from a global init.templateDir, and no auto-gc under the tar.
    git -c gc.auto=0 init -q --bare --template= "$tmp/.git"
    git -C "$tmp/.git" -c gc.auto=0 fetch -q --no-tags --update-shallow "$src" '+refs/*:refs/*' \
      || die "pack: could not snapshot the refs of $src"
    if [ -z "$branch" ]; then
      branch="detached-${head:0:12}"
      git -C "$tmp/.git" fetch -q --no-tags --update-shallow "$src" "+HEAD:refs/heads/$branch"
    fi
    git -C "$tmp/.git" symbolic-ref HEAD "refs/heads/$branch"
    git -C "$tmp/.git" config core.bare false
    gitdir=$(cd "$src" && cd "$(git rev-parse --git-common-dir)" && pwd)
    while IFS= read -r -d '' entry; do
      # A key with no value (`[remote "x"] mirror`) is boolean true.
      case $entry in *$'\n'*) ;; *) entry="$entry"$'\n'true ;; esac
      git -C "$tmp/.git" config --add "${entry%%$'\n'*}" "${entry#*$'\n'}"
    done < <(git -C "$gitdir" config --local --null --get-regexp '^(remote|branch)\.' 2>/dev/null || true)
    # The checkout's index rides along so the VM's status matches, except a
    # split index, whose shared half lives only in the original git dir. The
    # index's blobs that HEAD's tree lacks (staged, intent-to-add, the stages
    # of an unmerged entry) are behind no ref, so they travel as a pack of
    # their own; without them the VM's write-tree (gstack-wtree) cannot read a
    # staged file.
    if [ "$(git -C "$src" config --bool core.splitIndex 2>/dev/null)" != true ]; then
      cp "$(cd "$src" && cd "$(dirname "$(git rev-parse --git-path index)")" && pwd)/index" "$tmp/.git/index"
      # Read the copy, not the live index, so the pack matches it; a gitlink's
      # sha (mode 160000) is a submodule commit this object store lacks.
      GIT_INDEX_FILE="$tmp/.git/index" git -C "$src" ls-files -s | awk '$1 != "160000" {print $2}' | sort -u \
        | comm -23 - <(git -C "$src" ls-tree -r HEAD | awk '{print $3}' | sort -u) \
        | git -C "$src" pack-objects -q --stdout \
        | git -C "$tmp/.git" unpack-objects -q \
        || die "pack: could not snapshot the staged blobs of $src"
    fi
    (
      cd "$src"
      git ls-files -z -co --exclude-standard \
        | while IFS= read -r -d '' f; do
            if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
          done \
        | tar --null -T - -c -C "$tmp" .git -zf -
    )
    rm -rf "$tmp"; trap - EXIT
  else
    tar -C "$src" -czf - .
  fi
}

# unpack NAME DEST: extract a tarball read from stdin into DEST on the VM.
cmd_unpack() {
  local qdest
  qdest=$(printf %q "$2")
  remote "$1" "mkdir -p $qdest && tar -xzf - -C $qdest"
}

cmd_sync() {
  local name=$1 src=${2:-.} dest=${3:-}
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"
  cmd_pack "$src" | cmd_unpack "$name" "$dest"
  log "synced $src -> $name:$dest"
}

# pull NAME REMOTE_GLOB LOCAL_DIR: copy matching remote entries into LOCAL_DIR.
# Relative remote paths start at /home/ubi. A glob that matches nothing (for
# example an optional flake ledger) is reported and skipped, not a failure.
cmd_pull() {
  local name=$1 from=$2 to=$3 dir
  dir=$(printf %q "$(dirname "$from")")
  if ! remote "$name" "cd $dir 2>/dev/null && ls -d -- $(basename "$from") >/dev/null 2>&1"; then
    log "pull: nothing matches $from"
    return 0
  fi
  mkdir -p "$to"
  remote "$name" "cd $dir && tar -czf - $(basename "$from")" | tar -xzf - -C "$to"
}

# pass_name NAME: a variable this runner may forward to a VM. Its own
# credentials (UBICLOUD_*) never leave this machine, whoever asks.
pass_name() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "--pass $1: not a variable name"
  case $1 in UBICLOUD_*) die "--pass $1: the runner never forwards its own Ubicloud credentials to a VM" ;; esac
}

# inside_dir DIR ROOT: DIR resolves, symlinks followed, to ROOT or below it.
# Its nearest existing ancestor is checked first, so a refused destination
# creates nothing (not even outside the root); only then is DIR created and
# checked again.
inside_dir() {
  local a b near=$1
  b=$(cd "$2" 2>/dev/null && pwd -P) || return 1
  while [ ! -d "$near" ]; do
    [ "$near" != "$(dirname "$near")" ] || return 1
    near=$(dirname "$near")
  done
  a=$(cd "$near" 2>/dev/null && pwd -P) || return 1
  [ "$a" = "$b" ] || [[ "$a" = "$b"/* ]] || return 1
  mkdir -p "$1" 2>/dev/null || return 1
  a=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  [ "$a" = "$b" ] || [[ "$a" = "$b"/* ]]
}

# PULL_ROOT: set by verify; every pull destination must resolve inside it at
# pull time (an earlier pull may have placed a symlink where a later one lands).
PULL_ROOT=""

# run_teardown RC: run's EXIT handler. Destroys RUN_VM, ignoring further
# signals, then checks the project's VM list for it and prints the leftover
# line; a VM still listed, or a list that cannot be read, fails the run.
run_teardown() {
  local rc=$1 rows left others
  trap "" INT TERM HUP QUIT
  cmd_down "$RUN_VM" || log "WARNING: failed to destroy $RUN_VM; run: $0 down $RUN_VM"
  if rows=$(vm_rows 2>/dev/null); then
    left=$(awk -v n="$RUN_VM" '$2==n' <<<"$rows" | grep -c . || true)
    others=$(awk -v n="$RUN_VM" -v o="$OWNER" '$3==o && $2!=n' <<<"$rows" | grep -c . || true)
  else
    left=unknown others=unknown
  fi
  leftover "left=$left owner=$OWNER vm=$RUN_VM others=$others"
  [ "$left" = 0 ] && return 0
  log "VM cleanup not confirmed for $RUN_VM (left=$left); destroy it with: $0 down $RUN_VM"
  [ "$rc" -ne 0 ] || exit 1
}

cmd_run() {
  require_owner
  local up_args=() src=. dest="" setup="" keep=0 pulls=() envs=()
  while [ $# -gt 0 ]; do
    case $1 in
      -S|--storage) check_storage "$2"; up_args+=("$1" "$2"); shift 2 ;;
      -s|--size|-l|--location|-n|--name|-b|--image) up_args+=("$1" "$2"); shift 2 ;;
      --src) src=$2; shift 2 ;;
      --dest) dest=$2; shift 2 ;;
      --setup) setup=$2; shift 2 ;;
      --env) envs+=("$2"); shift 2 ;;
      --pass) pass_name "$2"; [ -n "${!2+x}" ] || die "--pass $2: not set locally"; envs+=("$2=${!2}"); shift 2 ;;
      --pull) pulls+=("$2"); shift 2 ;;
      --keep) keep=1; shift ;;
      --) shift; break ;;
      *) die "run: unknown option $1" ;;
    esac
  done
  [ $# -gt 0 ] || die "run: missing command after --"
  [ -z "$setup" ] || [ -f "$setup" ] || die "setup script not found: $setup"
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"

  local i name=""
  for (( i = 0; i < ${#up_args[@]}; i += 2 )); do
    case ${up_args[i]} in -n|--name) name=${up_args[i+1]} ;; esac
  done
  [ -n "$name" ] || { name=$(new_name); up_args+=(-n "$name"); }
  RUN_VM=$name
  # Armed before the create request: an interrupted `up` still destroys its VM.
  # A second signal must not cut teardown short, so the EXIT handler ignores them.
  trap 'run_teardown "$?"' EXIT
  trap 'exit 130' INT TERM HUP QUIT
  cmd_up "${up_args[@]}" >/dev/null
  if [[ "$name" =~ -t([0-9]+)$ ]]; then
    log "$name carries a ${BASH_REMATCH[1]}h TTL (any later run of this script reaps it); if this process dies first: $0 down $name"
  elif [[ "$name" =~ ^$PREFIX-$OWNER-[0-9]{10}- ]]; then
    log "$name has no TTL (reap destroys it once it is ${LEGACY_HOURS}h old); if this process dies before its teardown line, destroy it with: $0 down $name"
  else
    log "$name has no TTL and no reapable name, so nothing reaps it; if this process dies before its teardown line, destroy it with: $0 down $name"
  fi
  if [ "$keep" = 1 ]; then
    trap - EXIT
    leftover "left=1 owner=$OWNER vm=$name kept=1"
    log "--keep: leaving $name running; destroy with: $0 down $name"
  fi

  local e
  for e in ${envs[@]+"${envs[@]}"}; do printf 'export %s=%q\n' "${e%%=*}" "${e#*=}"; done \
    | remote "$name" 'umask 077 && cat > ~/.ubirun-env'

  cmd_sync "$name" "$src" "$dest"
  local qdest rc=0
  qdest=$(printf %q "$dest")
  if [ -n "$setup" ]; then
    remote "$name" 'cat > ~/.ubirun-setup.sh' <"$setup"
    log "running setup $(basename "$setup")"
    watched "$name" setup "cd $qdest && . ~/.ubirun-env && bash -l ~/.ubirun-setup.sh" || { rc=$?; log "setup failed (exit $rc)"; exit "$rc"; }
  fi

  local start
  start=$(date +%s)
  log "running on $name: $*"
  watched "$name" command "cd $qdest && . ~/.ubirun-env && bash -lc $(printf %q "$*")" || rc=$?
  log "command exited $rc after $(( $(date +%s) - start ))s"

  local p
  for p in ${pulls[@]+"${pulls[@]}"}; do
    if [ -n "$PULL_ROOT" ] && ! inside_dir "${p#*:}" "$PULL_ROOT"; then
      log "pull refused: ${p#*:} resolves outside $PULL_ROOT"
      [ "$rc" -ne 0 ] || rc=1
      continue
    fi
    cmd_pull "$name" "${p%%:*}" "${p#*:}" || log "pull failed: $p"
  done
  return "$rc"
}

# verify [run opts] [--trust-config] [-- COMMAND]: run the repository's
# committed remote verify. .gstack/ubicloud.json under --src (default .)
# supplies setup, command, size, location, storage, image, env, pass and pull;
# flags given here and a trailing -- COMMAND override it. Without the file it
# refuses, so every lane runs the one committed definition instead of its own
# wrapper.
#
# The file is repository content and gets no reach beyond the checkout on its
# own: its setup script and pull destinations must resolve inside --src, and a
# local variable it lists under pass is forwarded only when this command line
# also names it (--pass NAME) or grants every listed name (--trust-config).
cmd_verify() {
  local src=. i j g n cfg cfg_setup cfg_cmd parsed err rc=0 trust=0 cfg_args=() cfg_pass=() user_pre=() user_cmd=() granted=() missing=()
  for (( i = 1; i <= $#; i++ )); do
    [ "${!i}" = -- ] && break
    if [ "${!i}" = --src ]; then j=$(( i + 1 )); src=${!j}; fi
  done
  cfg="$src/.gstack/ubicloud.json"
  [ -f "$cfg" ] || die "verify: no $cfg; commit one ({\"setup\": \"scripts/ubicloud/bootstrap.sh\", \"command\": \"bash scripts/ubicloud/verify.sh\"}) so every lane runs the same verify instead of its own wrapper"
  err=$(mktemp)
  parsed=$(python3 -c '
import json, os, shlex, sys
cfg, src = sys.argv[1], sys.argv[2]
try:
    c = json.load(open(cfg))
except ValueError:
    sys.exit(3)
if not isinstance(c, dict):
    sys.exit(3)
base, root = os.path.abspath(src), os.path.realpath(src)
def inside(rel, what):
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or rel.startswith("~") or ".." in rel.replace("\\", "/").split("/"):
        print("%s %r must be a relative path inside the checkout" % (what, rel), file=sys.stderr); sys.exit(2)
    full = os.path.realpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        print("%s %r resolves outside the checkout (%s)" % (what, rel, full), file=sys.stderr); sys.exit(2)
    return os.path.join(base, rel)
q = lambda s: shlex.quote(str(s))
args = []
for key, flag in (("size", "-s"), ("location", "-l"), ("storage", "-S"), ("image", "-b")):
    if key in c: args += [flag, q(c[key])]
for item in c.get("env", []): args += ["--env", q(item)]
for item in c.get("pull", []):
    remote, sep, local = str(item).partition(":")
    if not sep or not remote:
        print("pull entry %r must be REMOTE_GLOB:LOCAL_DIR" % (item,), file=sys.stderr); sys.exit(2)
    args += ["--pull", q(remote + ":" + inside(local, "pull destination"))]
setup = c.get("setup", "")
print("cfg_args=(" + " ".join(args) + ")")
print("cfg_pass=(" + " ".join(q(x) for x in c.get("pass", [])) + ")")
print("cfg_setup=" + q(inside(setup, "setup") if setup else ""))
print("cfg_cmd=" + q(c.get("command", "")))
' "$cfg" "$src" 2>"$err") || rc=$?
  case $rc in
    0) ;;
    2) local why; why=$(cat "$err"); rm -f "$err"; die "verify: $cfg: $why" ;;
    *) rm -f "$err"; die "verify: $cfg is not valid JSON" ;;
  esac
  rm -f "$err"
  eval "$parsed"
  while [ $# -gt 0 ]; do
    case $1 in
      --) shift; user_cmd=("$@"); break ;;
      --trust-config) trust=1; shift ;;
      --keep) user_pre+=("$1"); shift ;;
      --pass|-S|--storage|-s|--size|-l|--location|-n|--name|-b|--image|--src|--dest|--setup|--env|--pull)
        [ $# -ge 2 ] || die "verify: $1 needs a value"
        [ "$1" != --pass ] || granted+=("$2")
        user_pre+=("$1" "$2"); shift 2 ;;
      *) die "verify: unknown option $1" ;;
    esac
  done
  for n in ${cfg_pass[@]+"${cfg_pass[@]}"}; do
    pass_name "$n"
    if [ "$trust" = 1 ]; then cfg_args+=(--pass "$n"); continue; fi
    for g in ${granted[@]+"${granted[@]}"}; do [ "$g" = "$n" ] && continue 2; done
    missing+=("$n")
  done
  [ ${#missing[@]} -eq 0 ] || die "verify: $cfg asks to forward local ${missing[*]}; grant each on this command line with --pass NAME, or every name it lists with --trust-config"
  [ ${#user_cmd[@]} -gt 0 ] || [ -n "$cfg_cmd" ] || die "verify: $cfg names no command and none was given after --"
  [ ${#user_cmd[@]} -gt 0 ] || user_cmd=("$cfg_cmd")
  log "verify: $cfg"
  PULL_ROOT=$(cd "$src" && pwd)
  cmd_run ${cfg_args[@]+"${cfg_args[@]}"} ${cfg_setup:+--setup "$cfg_setup"} --src "$src" ${user_pre[@]+"${user_pre[@]}"} -- "${user_cmd[@]}"
}

usage() {
  cat <<EOF
usage: ubi-runner.sh <command> [args]

  run [up opts] [--src DIR] [--dest PATH] [--setup FILE] [--env K=V]...
      [--pass NAME]... [--pull REMOTE_GLOB:LOCAL_DIR]... [--keep] -- COMMAND
                         up + sync + setup + command + pull + destroy; exits with COMMAND's status
  verify [run opts] [--trust-config] [-- COMMAND]
                         run the repository's committed verify (.gstack/ubicloud.json under --src);
                         its setup script and every pull destination stay inside --src (checked
                         again at pull time), and its pass names are forwarded only when granted
                         here (--pass NAME, or all: --trust-config)
  up [-s SIZE] [-l LOCATION] [-n NAME] [-S STORAGE_GIB] [-b IMAGE]
                         create a VM and wait for SSH; prints its name
                         (STORAGE_GIB: one of $ALLOWED_STORAGE)
  ssh NAME [COMMAND]     shell or login-shell command on the VM (user ubi, passwordless sudo)
  sync NAME [SRC] [DEST] stream a checkout (tracked + untracked-unignored + .git)
  pack [SRC]             write that checkout tarball to stdout
  unpack NAME DEST       extract a tarball from stdin into DEST on the VM
  pull NAME REMOTE_GLOB LOCAL_DIR
                         copy matching remote entries into LOCAL_DIR
  down NAME [-l LOC]     destroy the VM; returns once it is confirmed gone or never existed
  list [--mine]          list all VMs in the project, or only this owner's
  usage                  VMs and vCPUs per owner across the project
  owner                  print this caller's owner tag ($OWNER)
  records                VMs this machine created and has not confirmed gone ($VM_RECORD)
  gc HOURS               destroy this owner's VMs older than HOURS (never other owners')
  reap                   destroy every VM whose -t<hours> TTL has ended (any owner) and this
                         owner's TTL-less ubirun-* VMs older than UBI_LEGACY_HOURS
  cli ARGS...            raw Ubicloud CLI passthrough (e.g. cli vm list)

VMs are named $PREFIX-<owner>-<epoch>-<suffix>-t<ttl hours>; up, run and verify need
UBI_OWNER (e.g. your thread code); run and verify end with a UBICLOUD: left=<n> line.
defaults: size=$DEFAULT_SIZE location=$DEFAULT_LOCATION (env UBI_SIZE, UBI_LOCATION)
env: UBI_TTL_HOURS (${TTL_HOURS}h in the name, 1-999), UBI_REAP (0: up skips the reap),
     UBI_LEGACY_HOURS (${LEGACY_HOURS}h: reap's bound for this owner's TTL-less ubirun-* names),
     UBI_IDLE_TIMEOUT (${IDLE_TIMEOUT}s of silence kills the remote command, exit 124; 0 disables),
     UBI_RUN_TIMEOUT (${RUN_TIMEOUT}s wall clock; 0 unlimited), UBI_HEARTBEAT (${HEARTBEAT}s between heartbeat lines),
     UBI_QUOTA_VCPUS (project vCPU ceiling for the preflight; else the last refusal's maximum),
     UBI_QUOTA_WAIT (${QUOTA_WAIT}s to wait for quota room instead of refusing),
     UBI_GC_HOURS (unset/0: no sweep on up), UBI_CREATE_GRACE (${CREATE_GRACE}s),
     UBI_DOWN_TIMEOUT (${DOWN_TIMEOUT}s), UBI_API_TIMEOUT (${API_TIMEOUT}s), UBI_VM_RECORD (scratch VM-id file),
     UBI_ALLOWED_STORAGE (the -S sizes Ubicloud accepts; default "320 640")
EOF
}

cmd=${1:-help}
[ $# -eq 0 ] || shift
case $cmd in
  owner|pack|records|help|-h|--help) ;;
  *) [ -n "${UBICLOUD_API_KEY:-}" ] || die "UBICLOUD_API_KEY is not set (create a token under your Ubicloud project's Tokens page)" ;;
esac
case $cmd in
  run) cmd_run "$@" ;;
  verify) cmd_verify "$@" ;;
  up) trap 'trap "" INT TERM HUP QUIT; [ -z "$UP_NAME" ] || [ -n "$UP_READY" ] || cmd_down "$UP_NAME" || log "WARNING: failed to destroy $UP_NAME; run: $0 down $UP_NAME"' EXIT
      trap 'exit 130' INT TERM HUP QUIT
      cmd_up "$@" ;;
  ssh) name=$1; shift; load "$name"
       # shellcheck disable=SC2046
       if [ $# -eq 0 ]; then exec ssh -t $(ssh_opts) "ubi@$IP"; else watched "$name" ssh "bash -lc $(printf %q "$*")"; fi ;;
  sync) cmd_sync "$@" ;;
  pack) cmd_pack "$@" ;;
  unpack) cmd_unpack "$@" ;;
  pull) cmd_pull "$@" ;;
  down) cmd_down "$@" ;;
  list) cmd_list "$@" ;;
  usage) cmd_usage ;;
  owner) echo "$OWNER" ;;
  records) cmd_records ;;
  gc) cmd_gc "$@" ;;
  reap) cmd_reap ;;
  cli) cli "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
