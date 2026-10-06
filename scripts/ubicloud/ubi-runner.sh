#!/usr/bin/env bash
# ubi-runner — run a command on an ephemeral Ubicloud VM.
#
#   UBICLOUD_API_KEY=... scripts/ubicloud/ubi-runner.sh run --setup S.sh -- 'make test'
#
# Creates a VM (standard-16 by default), streams the checkout to it (tracked +
# untracked-unignored files + .git, so uncommitted edits are included), runs an
# optional setup script and the command, copies requested artifacts back, and
# destroys the VM on every exit path. Exits with the command's status.
# Needs only bash, curl, python3, ssh, ssh-keygen, and tar locally, so it works
# from dev boxes, containers, and cloud sandboxes. VMs are named
# ubirun-<epoch>-<hex>. Every exit path destroys this client's VM. Nothing
# sweeps stale VMs by default: the project quota is shared with other agents'
# runners, and an age-only sweep destroyed their long runs too. Set
# UBI_GC_HOURS to a positive number, or run `gc HOURS`, to opt in.
set -euo pipefail
# Keep heredoc bodies on temp files, not the pipe window (test/heredoc-pipe-deadlock.test.ts).
BASH_COMPAT=50

API="${UBICLOUD_API_URL:-https://api.ubicloud.com}"
STATE_ROOT="${UBI_RUNNER_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ubi-runner}"
DEFAULT_SIZE="${UBI_SIZE:-standard-16}"
DEFAULT_LOCATION="${UBI_LOCATION:-eu-central-h1}"
GC_HOURS="${UBI_GC_HOURS:-0}"
PREFIX="ubirun"

die() { echo "ubi-runner: $*" >&2; exit 1; }
log() { echo "ubi-runner: $*" >&2; }

for bin in curl python3 ssh ssh-keygen tar; do
  command -v "$bin" >/dev/null || die "$bin is required"
done
[ -n "${UBICLOUD_API_KEY:-}" ] || die "UBICLOUD_API_KEY is not set (create a token under your Ubicloud project's Tokens page)"

cli() {
  local out code
  out=$(mktemp)
  code=$(python3 -c 'import json,sys; print(json.dumps({"argv": sys.argv[1:]}))' "$@" \
    | curl -sS -o "$out" -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $UBICLOUD_API_KEY" \
        -H 'Accept: text/plain' -H 'Content-Type: application/json' \
        -H 'X-Ubi-Version: 1.0.0' --data @- "$API/cli") || { rm -f "$out"; die "request failed: ubi $*"; }
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
    -o LogLevel=ERROR -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=10
}

# Ubuntu's default umask (002) leaves new directories group-writable, which
# permission-checking code under test rejects; every remote command uses 022.
remote() {
  local name=$1; shift
  load "$name"
  # shellcheck disable=SC2046
  ssh $(ssh_opts) "ubi@$IP" "umask 022; $*"
}

cmd_gc() {
  local hours=${1:-$GC_HOURS} now loc name ts
  [ "$hours" -gt 0 ] || return 0
  now=$(date +%s)
  cli vm list -N -f location,name | while read -r loc name; do
    [[ "$name" =~ ^${PREFIX}-([0-9]{10})- ]] || continue
    ts=${BASH_REMATCH[1]}
    if [ $(( (now - ts) / 3600 )) -ge "$hours" ]; then
      log "destroying stale $loc/$name (older than ${hours}h)"
      cli vm "$loc/$name" destroy -f >/dev/null || log "failed to destroy $loc/$name"
      rm -rf "$(state_dir "$name")"
    fi
  done
}

write_state() {
  printf 'NAME=%q\nLOCATION=%q\nSIZE=%q\nIP=%q\n' "$1" "$2" "$3" "$4" >"$(state_dir "$1")/env"
}

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
  [ -n "$name" ] || name="$PREFIX-$(date +%s)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cmd_gc "$GC_HOURS" || log "stale-VM cleanup failed; continuing"

  local dir
  dir=$(state_dir "$name")
  mkdir -p "$dir"
  chmod 700 "$dir"
  ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$dir/key"

  local args=(vm "$location/$name" create -s "$size" -b "$image")
  [ -z "$storage" ] || args+=(-S "$storage")
  args+=("$(cat "$dir/key.pub")")
  log "creating $location/$name ($size)"
  cli "${args[@]}" >/dev/null || { rm -rf "$dir"; die "create failed"; }
  write_state "$name" "$location" "$size" ""

  local deadline=$(( $(date +%s) + 600 )) show state ip
  while :; do
    show=$(cli vm "$location/$name" show 2>/dev/null || true)
    state=$(sed -n 's/^state: //p' <<<"$show")
    ip=$(sed -n 's/^ip4: //p' <<<"$show")
    [ "$state" = running ] && [ -n "$ip" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || { cmd_down "$name"; die "VM did not reach running in 10 minutes (last state: ${state:-unknown})"; }
    sleep 5
  done
  write_state "$name" "$location" "$size" "$ip"

  load "$name"
  deadline=$(( $(date +%s) + 300 ))
  # shellcheck disable=SC2046
  until ssh $(ssh_opts) "ubi@$IP" true 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || { cmd_down "$name"; die "SSH did not come up on $IP"; }
    sleep 5
  done
  remote "$name" 'cloud-init status --wait >/dev/null 2>&1 || true'
  log "ready: $name ($IP)"
  echo "$name"
}

cmd_down() {
  local name=$1 dir loc
  dir=$(state_dir "$name")
  if [ -f "$dir/env" ]; then
    load "$name"
    loc=$LOCATION
  else
    loc=$(cli vm list -N -f location,name | awk -v n="$name" '$2==n {print $1}')
    [ -n "$loc" ] || die "VM '$name' not found"
  fi
  # A failed destroy, or a VM still listed afterwards, is a failure: callers
  # report success only when the VM is really gone.
  if ! cli vm "$loc/$name" destroy -f >/dev/null; then
    log "FAILED to destroy $loc/$name; retry: $0 down $name"
    return 1
  fi
  local i
  for i in $(seq 1 30); do
    cli vm list -N -f location,name | awk -v n="$name" '$2==n {found=1} END {exit !found}' || { log "destroyed $loc/$name"; rm -rf "$dir"; return 0; }
    sleep 2
  done
  log "FAILED: $loc/$name is still listed after destroy; retry: $0 down $name"
  return 1
}

cmd_sync() {
  local name=$1 src=${2:-.} dest=${3:-}
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"
  local qdest
  qdest=$(printf %q "$dest")
  if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    (
      cd "$src"
      { git ls-files -z -co --exclude-standard; printf '.git\0'; } \
        | while IFS= read -r -d '' f; do
            if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
          done \
        | tar --null -T - -czf -
    ) | remote "$name" "mkdir -p $qdest && tar -xzf - -C $qdest"
  else
    tar -C "$src" -czf - . | remote "$name" "mkdir -p $qdest && tar -xzf - -C $qdest"
  fi
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

  RUN_VM=$(cmd_up ${up_args[@]+"${up_args[@]}"})
  local name=$RUN_VM
  if [ "$keep" = 1 ]; then
    log "--keep: leaving $name running; destroy with: $0 down $name"
  else
    trap 'cmd_down "$RUN_VM" || log "WARNING: failed to destroy $RUN_VM; run: $0 down $RUN_VM"' EXIT
    trap 'exit 130' INT TERM
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
  pull NAME REMOTE_GLOB LOCAL_DIR
                         copy matching remote entries into LOCAL_DIR
  down NAME              destroy the VM
  list                   list all VMs in the project
  gc HOURS               destroy $PREFIX-* VMs older than HOURS (every owner's; off by default)
  cli ARGS...            raw Ubicloud CLI passthrough (e.g. cli vm list)

defaults: size=$DEFAULT_SIZE location=$DEFAULT_LOCATION (env UBI_SIZE, UBI_LOCATION)
EOF
}

cmd=${1:-help}
[ $# -eq 0 ] || shift
case $cmd in
  run) cmd_run "$@" ;;
  up) cmd_up "$@" ;;
  ssh) name=$1; shift; load "$name"
       # shellcheck disable=SC2046
       if [ $# -eq 0 ]; then exec ssh -t $(ssh_opts) "ubi@$IP"; else remote "$name" "bash -lc $(printf %q "$*")"; fi ;;
  sync) cmd_sync "$@" ;;
  pull) cmd_pull "$@" ;;
  down) cmd_down "$@" ;;
  list) cli vm list ;;
  gc) cmd_gc "$@" ;;
  cli) cli "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
