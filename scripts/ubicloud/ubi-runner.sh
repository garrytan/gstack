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
# Ownership: VMs are named ubirun-<owner>-<epoch>-<suffix>. <owner> is UBI_OWNER
# (lowercased, letters and digits only, at most 12 characters, starting with a
# letter) or a random per-machine id kept in $STATE_ROOT/owner-id. Ubicloud names
# allow 63 characters of [a-z0-9-], so a full name stays under 40.
#
# Teardown: `up` records each VM's state (location, create status) before it
# sends the create request, and `down` destroys and polls until the VM is
# confirmed gone or provably never existed, waiting out a create that may still
# be in flight. An interrupted `up` or `run` (EXIT, INT, TERM, HUP, QUIT) runs
# that `down`; further signals are ignored until it finishes. A create refused
# for vCPU quota prints the project's usage per owner.
#
# Stale-VM sweeps are off by default. With UBI_GC_HOURS set to a positive
# number, every `up` first destroys this owner's VMs older than that; `gc HOURS`
# runs the same sweep on demand. Neither ever touches another owner's VMs.
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

# vm_rows: "location name owner" for every VM in the project; owner is
# "-" for untagged ubirun-<epoch>-* names and "." for VMs this runner did not name.
vm_rows() {
  cli vm list -N -f location,name | while read -r loc name; do
    if [[ "$name" =~ ^${PREFIX}-([a-z][a-z0-9]{0,11})-[0-9]{10}- ]]; then
      echo "$loc $name ${BASH_REMATCH[1]}"
    elif [[ "$name" =~ ^${PREFIX}-[0-9]{10}- ]]; then
      echo "$loc $name -"
    else
      echo "$loc $name ."
    fi
  done
}

cmd_gc() {
  local hours=${1:-$GC_HOURS} now loc name owner
  [[ "$hours" =~ ^[0-9]+$ ]] || die "gc: HOURS must be a whole number (or set UBI_GC_HOURS)"
  if [ "$hours" -eq 0 ]; then log "gc: no sweep (give HOURS > 0 or set UBI_GC_HOURS); nothing listed, nothing destroyed"; return 0; fi
  now=$(date +%s)
  vm_rows | while read -r loc name owner; do
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
  while read -r loc name owner; do
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

new_name() { echo "$PREFIX-$OWNER-$(date +%s)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }

valid_name() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; }

UP_NAME=""
UP_READY=""
cmd_up() {
  local size=$DEFAULT_SIZE location=$DEFAULT_LOCATION name="" storage="" image=ubuntu-noble
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size) size=$2; shift 2 ;;
      -l|--location) location=$2; shift 2 ;;
      -n|--name) name=$2; shift 2 ;;
      -S|--storage) storage=$2; shift 2 ;;
      -b|--image) image=$2; shift 2 ;;
      *) die "up: unknown option $1" ;;
    esac
  done
  [ -n "$name" ] || name=$(new_name)
  valid_name "$name" || die "invalid VM name '$name' (Ubicloud allows 1-63 of a-z, 0-9 and '-', starting and ending with a letter or digit)"
  if [ "$GC_HOURS" -gt 0 ]; then
    cmd_gc "$GC_HOURS" || log "stale-VM cleanup failed; continuing"
  fi

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
# files that are not ignored, plus .git; a non-git directory is taken whole).
cmd_pack() {
  local src
  src=$(cd "${1:-.}" && pwd)
  if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    (
      cd "$src"
      { git ls-files -z -co --exclude-standard; printf '.git\0'; } \
        | while IFS= read -r -d '' f; do
            if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
          done \
        | tar --null -T - -czf -
    )
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

cmd_run() {
  local up_args=() src=. dest="" setup="" keep=0 pulls=() envs=()
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size|-l|--location|-n|--name|-S|--storage|-b|--image) up_args+=("$1" "$2"); shift 2 ;;
      --src) src=$2; shift 2 ;;
      --dest) dest=$2; shift 2 ;;
      --setup) setup=$2; shift 2 ;;
      --env) envs+=("$2"); shift 2 ;;
      --pass) [ -n "${!2+x}" ] || die "--pass $2: not set locally"; envs+=("$2=${!2}"); shift 2 ;;
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
  trap 'trap "" INT TERM HUP QUIT; cmd_down "$RUN_VM" || log "WARNING: failed to destroy $RUN_VM; run: $0 down $RUN_VM"' EXIT
  trap 'exit 130' INT TERM HUP QUIT
  cmd_up "${up_args[@]}" >/dev/null
  if [ "$keep" = 1 ]; then
    trap - EXIT
    log "--keep: leaving $name running; destroy with: $0 down $name"
  fi

  local e
  for e in ${envs[@]+"${envs[@]}"}; do printf 'export %s=%q\n' "${e%%=*}" "${e#*=}"; done \
    | remote "$name" 'umask 077 && cat > ~/.ubirun-env'

  cmd_sync "$name" "$src" "$dest"
  local qdest
  qdest=$(printf %q "$dest")
  if [ -n "$setup" ]; then
    remote "$name" 'cat > ~/.ubirun-setup.sh' <"$setup"
    log "running setup $(basename "$setup")"
    remote "$name" "cd $qdest && . ~/.ubirun-env && bash -l ~/.ubirun-setup.sh" || die "setup failed"
  fi

  local start rc=0
  start=$(date +%s)
  log "running on $name: $*"
  remote "$name" "cd $qdest && . ~/.ubirun-env && bash -lc $(printf %q "$*")" || rc=$?
  log "command exited $rc after $(( $(date +%s) - start ))s"

  local p
  for p in ${pulls[@]+"${pulls[@]}"}; do
    cmd_pull "$name" "${p%%:*}" "${p#*:}" || log "pull failed: $p"
  done
  return "$rc"
}

usage() {
  cat <<EOF
usage: ubi-runner.sh <command> [args]

  run [up opts] [--src DIR] [--dest PATH] [--setup FILE] [--env K=V]...
      [--pass NAME]... [--pull REMOTE_GLOB:LOCAL_DIR]... [--keep] -- COMMAND
                         up + sync + setup + command + pull + destroy; exits with COMMAND's status
  up [-s SIZE] [-l LOCATION] [-n NAME] [-S STORAGE_GIB] [-b IMAGE]
                         create a VM and wait for SSH; prints its name
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
  cli ARGS...            raw Ubicloud CLI passthrough (e.g. cli vm list)

VMs are named $PREFIX-<owner>-<epoch>-<suffix>; set UBI_OWNER (e.g. your thread
code) to tag them, otherwise a per-machine id is used.
defaults: size=$DEFAULT_SIZE location=$DEFAULT_LOCATION (env UBI_SIZE, UBI_LOCATION)
env: UBI_GC_HOURS (unset/0: no sweep on up), UBI_CREATE_GRACE (${CREATE_GRACE}s),
     UBI_DOWN_TIMEOUT (${DOWN_TIMEOUT}s), UBI_API_TIMEOUT (${API_TIMEOUT}s), UBI_VM_RECORD (scratch VM-id file)
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
  up) trap 'trap "" INT TERM HUP QUIT; [ -z "$UP_NAME" ] || [ -n "$UP_READY" ] || cmd_down "$UP_NAME" || log "WARNING: failed to destroy $UP_NAME; run: $0 down $UP_NAME"' EXIT
      trap 'exit 130' INT TERM HUP QUIT
      cmd_up "$@" ;;
  ssh) name=$1; shift; load "$name"
       # shellcheck disable=SC2046
       if [ $# -eq 0 ]; then exec ssh -t $(ssh_opts) "ubi@$IP"; else remote "$name" "bash -lc $(printf %q "$*")"; fi ;;
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
  cli) cli "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
