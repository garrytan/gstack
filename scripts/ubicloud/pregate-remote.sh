#!/usr/bin/env bash
# pregate-remote.sh — gstack's declared remote_gate (.gstack/pregate.json).
#
# gstack-pregate runs this under 8 cores for --stage tests --remote:
#
#   gstack-pregate --stage tests --remote --spend-cap 2 --allow-repo-commands
#
# with PREGATE_FILES_FILE (the selected test files, one per line),
# PREGATE_TREE (the working-tree fingerprint being tested) and
# PREGATE_SPEND_CAP_USD. It prints the contract line pregate reads
# (docs/pregate.md#remote-gate):
#
#   PREGATE_REMOTE: tree=<tree tested> tests=<n> failed=<n> spent=<usd>
#
# With UBICLOUD_API_KEY set it runs the files on one Ubicloud VM with the
# environment of bun run test:ubicloud (scripts/ubicloud/test-free.sh:
# setup-free-suite.sh, xvfb-run, GSTACK_EXPECT_BINARIES=1, the free retry
# policy), through test-free-shards.ts --files-from. The wall timeout is the
# whole minutes the cap buys at the size's list price (UBI_SIZE, default
# standard-16), at most 45; under 20 (the shortest useful run) it refuses
# before the VM is created. On the VM it recomputes bin/gstack-wtree
# after unpack (the tree reported) and checks that the planned set's digest
# equals the list's before any test runs. Setup rebuilds committed build
# output exactly as the CI free lane does (lib/diagram-render/dist is not
# byte-reproducible there); the script prints what setup rewrote, and the
# tests must leave the post-setup tree unchanged. spent= is billed minutes (create to confirmed
# teardown) times the size's price. Without a key it runs the same files
# locally in parallel shards and reports spent=0.
#
# Exit codes: 0 pass (or a paid-only selection, tests=0); 1 test failures (or
# a rejected file list); 2 missing input; 3 tree or plan mismatch (or the tree
# moved during the run); 4 infrastructure failure (create, setup, SSH, stop
# deadline); 5 the spend cap or pregate's deadline refuses the run. Every refusal line starts with a
# PREGATE_REMOTE_* reason code (docs/pregate.md#remote-gate). Nothing is
# uploaded or spent before the local tree check.
set -euo pipefail
# Keep heredoc bodies on temp files, not the pipe window (test/heredoc-pipe-deadlock.test.ts).
BASH_COMPAT=50

# The whole script is one braced block, so bash parses it before running and an
# edit to this file during a run cannot change what the run executes.
{
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
rerun='gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands'

say() { printf 'pregate-remote: %s\n' "$@"; }
stop() { local code=$1 reason=$2; shift 2; say "$reason: $1"; shift; [ $# -eq 0 ] || say "$@"; say "see docs/pregate.md#remote-gate"; exit "$code"; }

[ -n "${PREGATE_FILES_FILE:-}" ] || stop 2 PREGATE_REMOTE_USAGE "PREGATE_FILES_FILE is not set; run: $rerun"
[ -n "${PREGATE_TREE:-}" ] || stop 2 PREGATE_REMOTE_USAGE "PREGATE_TREE is not set; run: $rerun"
[ -f "$PREGATE_FILES_FILE" ] || stop 2 PREGATE_REMOTE_USAGE "PREGATE_FILES_FILE=$PREGATE_FILES_FILE does not exist; run: $rerun"

started=$(date +%s)
wtree() { (cd "$root" && bin/gstack-wtree); }
tree=$(wtree) || stop 3 PREGATE_REMOTE_TREE_MISMATCH "bin/gstack-wtree could not fingerprint $root" "nothing uploaded, nothing spent" "rerun: $rerun"
if [ "$tree" != "$PREGATE_TREE" ]; then
  stop 3 PREGATE_REMOTE_TREE_MISMATCH "the working tree is ${tree:0:12}, not the planned tree ${PREGATE_TREE:0:12}" "nothing uploaded, nothing spent" "rerun: $rerun"
fi

logs="$root/.context/pregate-remote/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$logs"
log="$logs/run.log"

# pregate's selection can name paid test files (skill-e2e and other paid
# evals); the paid PR gate covers those, and test-free-shards --files-from
# rejects them, so only the free files go on.
files="$logs/free-files.txt"
paid=$(cd "$root" && bun -e 'import { isPaidTestFile } from "./test/helpers/paid-test-set.ts"; import * as fs from "node:fs";
const lines = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter(Boolean);
fs.writeFileSync(process.argv[2], lines.filter(f => !isPaidTestFile(f)).map(f => f + "\n").join(""));
console.log(lines.filter(f => isPaidTestFile(f)).join("\n"));' "$PREGATE_FILES_FILE" "$files") || stop 2 PREGATE_REMOTE_USAGE "could not split $PREGATE_FILES_FILE into free and paid test files"
if [ -n "$paid" ]; then
  say "$(grep -c . <<<"$paid") paid test file(s) are covered by the paid PR gate, not the free tier: $(head -5 <<<"$paid" | paste -sd, - | sed 's/,/, /g')$( [ "$(grep -c . <<<"$paid")" -le 5 ] || echo " ...")"
fi
count=$(grep -c . "$files" || true)
if [ "$count" -eq 0 ]; then
  say "PREGATE_REMOTE_PAID_ONLY: every selected file is a paid test file; no free test ran, so this receipt cannot clear the obligation (tests=0)" "see docs/pregate.md#remote-gate"
  echo "PREGATE_REMOTE: tree=$tree tests=0 failed=0 spent=0"
  exit 0
fi

result_line() { grep '^\[test:free\] FILES-FROM RESULT: ' "$1" | tail -1 || true; }
field() { sed -n "s/.* $1=\([0-9][0-9]*\).*/\1/p" <<<"$2"; }

if [ -z "${UBICLOUD_API_KEY:-${UBICLOUD_API_TOKEN:-}}" ]; then
  say "no UBICLOUD_API_KEY: running $count files locally in parallel shards"
  set +e
  (cd "$root" && bun run scripts/test-free-shards.ts --files-from "$files") 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  after=$(wtree) || after=unavailable
  if [ "$after" != "$tree" ]; then
    (cd "$root" && git diff --name-status "$tree" "$after" 2>&1 | head -20 | sed 's/^/  moved: /') || true
    stop 3 PREGATE_REMOTE_TREE_MOVED "the working tree moved during the run (${tree:0:12} before, ${after:0:12} after); no result reported" "log: $log" "rerun on a tree nothing else edits: $rerun"
  fi
  result=$(result_line "$log")
  [ -n "$result" ] || stop "$(( rc == 0 ? 1 : rc ))" PREGATE_REMOTE_NO_RESULT "test-free-shards exited $rc without a FILES-FROM RESULT line" "log: $log"
  say "log: $log"
  echo "backend=local ($(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu) cores; not the CI environment)"
  echo "PREGATE_REMOTE: tree=$tree tests=$(field tests "$result") failed=$(field failed "$result") spent=0"
  exit "$rc"
fi

size=${UBI_SIZE:-standard-16}
case $size in
  standard-2) ppm=0.00104 ;; standard-4) ppm=0.00208 ;; standard-8) ppm=0.00416 ;;
  standard-16) ppm=0.00831 ;; standard-30) ppm=0.01559 ;; standard-60) ppm=0.03117 ;;
  *) stop 5 PREGATE_REMOTE_NO_PRICE "no price for UBI_SIZE=$size (priced: standard-2, -4, -8, -16, -30, -60; Ubicloud list price per minute)" "nothing created, nothing spent" ;;
esac
cap=${PREGATE_SPEND_CAP_USD:-}
[[ "$cap" =~ ^[0-9]+(\.[0-9]+)?$ ]] || stop 2 PREGATE_REMOTE_USAGE "PREGATE_SPEND_CAP_USD is not a dollar amount ('$cap'); run: $rerun"
max_min=45 min_min=20
wall_min=$(awk -v c="$cap" -v p="$ppm" -v m="$max_min" 'BEGIN { w = int(c / p); print (w < m ? w : m) }')
usd() { awk -v m="$1" -v p="$ppm" 'BEGIN { s = m * p; c = int(s * 100); if (c < s * 100) c++; printf "%.2f", c / 100 }'; }
if [ "$wall_min" -lt "$min_min" ]; then
  stop 5 PREGATE_REMOTE_CAP_TOO_LOW "worst case \$$(usd "$min_min") ($min_min min x \$$ppm/min on $size) exceeds the spend cap \$$cap" "nothing created, nothing spent" "rerun with --spend-cap $(usd "$min_min") or more"
fi
# The enclosing gstack-pregate kills this gate at its --timeout (default 600 s)
# with a 5 s grace, so the VM must be told to stop early enough for teardown to
# be confirmed first: 120 s reserved for teardown plus 15 s margin. The deadline
# comes from PREGATE_TIMEOUT_S, else from the gstack-pregate process this gate
# runs under (its --timeout, else 600); run by hand there is none.
outer_s=${PREGATE_TIMEOUT_S:-} outer_from=PREGATE_TIMEOUT_S
if [ -z "$outer_s" ]; then
  outer_from="" pid=$PPID
  for _ in 1 2 3 4 5 6 7 8; do
    { [ -n "$pid" ] && [ "$pid" -gt 1 ]; } || break
    cmdline=$(ps -o args= -p "$pid" 2>/dev/null) || break
    case $cmdline in
      *gstack-pregate*)
        outer_s=$(sed -n 's/.*--timeout[ =]\([0-9][0-9]*\).*/\1/p' <<<"$cmdline")
        outer_s=${outer_s:-600} outer_from="gstack-pregate --timeout"
        break ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
fi
stop_after=$(( (wall_min - 3) * 60 )) stop_why="the cap's $wall_min min wall minus 3 min for teardown"
if [ -n "$outer_s" ]; then
  outer_stop=$(( outer_s - ($(date +%s) - started) - 135 ))
  if [ "$outer_stop" -lt 300 ]; then
    stop 5 PREGATE_REMOTE_TIMEOUT_TOO_SHORT "$outer_from ${outer_s}s leaves ${outer_stop}s for the VM after 120 s reserved for teardown and 15 s margin (at least 300 s needed)" "nothing created, nothing spent" "rerun with --timeout 2700: $rerun"
  fi
  if [ "$outer_stop" -lt "$stop_after" ]; then stop_after=$outer_stop stop_why="$outer_from ${outer_s}s minus 120 s teardown reserve and 15 s margin"; fi
fi
say "$count files on one $size VM; worst case \$$(usd "$wall_min") under the cap \$$cap; the VM is told to stop after ${stop_after}s ($stop_why)"

digest=$(tr -d '\r' <"$files" | grep . | LC_ALL=C sort | sha256sum | cut -d' ' -f1)
prelude="$logs/vm-setup.sh"
{
  printf '%s\n' 'set -euo pipefail' 'BASH_COMPAT=50' \
    'command -v git >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null; }' \
    'vm_tree=$(bin/gstack-wtree) || vm_tree=unavailable' \
    "if [ \"\$vm_tree\" != $tree ]; then echo \"PREGATE_VM_TREE_MISMATCH vm=\$vm_tree\"; exit 3; fi" \
    'echo "PREGATE_VM_TREE $vm_tree"' \
    "cat > ~/.pregate-files.txt <<'PREGATE_FILES'"
  tr -d '\r' <"$files" | grep .
  printf '%s\n' 'PREGATE_FILES' "cat > ~/.pregate-run.sh <<'PREGATE_RUN'" \
    'planned=$(bun run scripts/test-free-shards.ts --files-from ~/.pregate-files.txt --dry-run | sed -n "s/^\[test:free\] files-from .*: [0-9]* files, sha256=\([0-9a-f]*\)$/\1/p")' \
    "if [ \"\$planned\" != $digest ]; then echo \"PREGATE_VM_PLAN_MISMATCH planned=\${planned:-none} expected=$digest\"; exit 3; fi" \
    'xvfb-run -a bun run test:free --files-from ~/.pregate-files.txt' \
    'rc=$?' \
    'after=$(bin/gstack-wtree || echo unavailable)' \
    'built=$(cat ~/.pregate-built-tree)' \
    'echo "PREGATE_VM_TREE_AFTER $after"' \
    '[ "$after" = "$built" ] || git diff --name-status "$built" "$after" 2>&1 | head -20 | sed "s/^/PREGATE_VM_MOVED /"' \
    'exit $rc' \
    'PREGATE_RUN' \
    'bash scripts/ubicloud/setup-free-suite.sh' \
    'built=$(bin/gstack-wtree || echo unavailable)' \
    'echo "$built" > ~/.pregate-built-tree' \
    'echo "PREGATE_VM_TREE_BUILT $built"' \
    '[ "$built" = "$vm_tree" ] || git diff --name-status "$vm_tree" "$built" 2>&1 | head -20 | sed "s/^/PREGATE_VM_REBUILT /"'
} >"$prelude"

args=(run -s "$size" --src "$root" --setup "$prelude"
  --env GSTACK_EXPECT_BINARIES=1 --env GSTACK_FREE_RETRY_FLAKY=1
  --env GSTACK_FLAKE_LEDGER=/tmp/gstack-free-test-flake-ledger.jsonl
  --pull "/tmp/gstack-free-test-*:$logs"
  --pull "work/$(basename "$root")/.context/free-test-logs:$logs")
[ -z "${GSTACK_FREE_JOBS:-}" ] || args+=(--env "GSTACK_FREE_JOBS=$GSTACK_FREE_JOBS")

# The VM run gets its own session (python3, which ubi-runner already needs, for
# setsid on Linux and macOS): pregate's --timeout and stall kill signal this
# script's process group and then SIGKILL it, which must never cut ubi-runner's
# teardown short. Output goes to files (a dead reader would SIGPIPE ubi-runner),
# stamped for the phase timings; this script streams it. A watchdog sends
# ubi-runner TERM at the cap-derived wall timeout, and so does a TERM or INT
# to this script; ubi-runner then destroys the VM.
vm_session='
exec </dev/null > >(exec >/dev/null 2>&1; trap "" INT TERM HUP; while IFS= read -r line; do printf "%s %s\n" "$(date +%s)" "$line" >>"$2"; printf "%s\n" "$line" >>"$3"; done) 2>&1
bash "$4" "${@:5}" -- "bash ~/.pregate-run.sh" &
runner=$!
echo "$runner" >"$2.pid"
( sleep "$1"; touch "$2.timedout"; kill -TERM "$runner" ) </dev/null >/dev/null 2>&1 &
watchdog=$!
wait "$runner"
rc=$?
kill "$watchdog" 2>/dev/null
[ ! -f "$2.timedout" ] || rc=124
exit "$rc"
'
stream="$logs/stream.log"
at() { grep -m1 -E "^[0-9]+ $1" "$log" | cut -d' ' -f1 || true; }
( while sleep 60 </dev/null >/dev/null 2>&1; do say "still running ($(( $(date +%s) - started )) s)"; done ) &
heartbeat=$!
vmrun="" tailer=""
trap 'kill "$heartbeat" $tailer 2>/dev/null || true' EXIT
trap '[ -z "$vmrun" ] || kill -TERM "$(cat "$log.pid" 2>/dev/null)" 2>/dev/null; stop 130 PREGATE_REMOTE_INTERRUPTED "interrupted: ubi-runner is tearing the VM down on its own (log: $log)"' INT TERM

billed=0 attempt=0
while :; do
  attempt=$(( attempt + 1 ))
  : >"$log"
  : >"$stream"
  rm -f "$log.pid" "$log.timedout"
  t0=$(date +%s)
  vm_name="ubirun-$(bash "$here/ubi-runner.sh" owner)-$(date +%s)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  say "VM $vm_name; if this run is killed before its teardown line, destroy it with: bash scripts/ubicloud/ubi-runner.sh down $vm_name"
  python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    bash -c "$vm_session" pregate-remote-vm "$stop_after" "$log" "$stream" "$here/ubi-runner.sh" "${args[@]}" -n "$vm_name" &
  vmrun=$!
  tail -n +1 -f "$stream" &
  tailer=$!
  set +e
  wait "$vmrun"
  rc=$?
  set -e
  vmrun=""
  sleep 1
  kill "$tailer" 2>/dev/null || true
  tailer=""
  t_end=$(date +%s)
  t_create=$(at 'ubi-runner: creating ')
  if [ -n "$t_create" ] && ! grep -q 'ubi-runner: create failed' "$log"; then minutes=$(( (t_end - t_create + 59) / 60 )); billed=$(( billed + (minutes > 0 ? minutes : 1) )); fi
  if [ "$rc" -ne 0 ] && [ "$attempt" -eq 1 ] && grep -q 'vCPU quota exhausted' "$log"; then
    say "vCPU quota refused the VM; one retry in ${PREGATE_REMOTE_QUOTA_WAIT_S:-60} s"
    cp "$log" "$logs/attempt-1.log"
    sleep "${PREGATE_REMOTE_QUOTA_WAIT_S:-60}"
    continue
  fi
  break
done
spent=$(usd "$billed")

t_ready=$(at 'ubi-runner: ready: ')
t_setup=$(at 'ubi-runner: running setup')
t_run=$(at 'ubi-runner: running on ')
t_exit=$(at 'ubi-runner: command exited')
span() { if [ -n "$1" ] && [ -n "$2" ]; then echo "$(( $2 - $1 ))s"; else echo "-"; fi; }
say "phases: create $(span "$t0" "$t_ready"), setup $(span "$t_setup" "$t_run"), run $(span "$t_run" "$t_exit"), teardown $(span "$t_exit" "$t_end"); total $(( t_end - started ))s (target 600s)"
say "log: $log"

vm_tree=$(sed -n 's/^[0-9]* PREGATE_VM_TREE \([0-9a-f]*\)$/\1/p' "$log" | tail -1)
mismatch=$(grep -m1 -oE 'PREGATE_VM_(TREE|PLAN)_MISMATCH .*' "$log" || true)
if [ -n "$mismatch" ]; then
  stop 3 PREGATE_REMOTE_VM_TREE "the VM refused before running tests: $mismatch (expected tree ${tree:0:12})" "no tests ran; spent=$spent ($billed billed min on $size)" "rerun: $rerun"
fi
result=$(result_line <(cut -d' ' -f2- "$log"))
if [ -n "$result" ] && [ "$rc" -ne 124 ]; then
  after=$(sed -n 's/^[0-9]* PREGATE_VM_TREE_AFTER \(.*\)$/\1/p' "$log" | tail -1)
  built=$(sed -n 's/^[0-9]* PREGATE_VM_TREE_BUILT \(.*\)$/\1/p' "$log" | tail -1)
  sed -n 's/^[0-9]* PREGATE_VM_REBUILT /  setup rebuilt (committed build output, as the CI free lane rebuilds it): /p' "$log"
  if [ "$after" != "$built" ]; then
    sed -n 's/^[0-9]* PREGATE_VM_MOVED /  moved: /p' "$log"
    stop 3 PREGATE_REMOTE_TREE_MOVED "the VM's tree moved during the run (${built:0:12} after setup, ${after:0:12} after tests); no result reported" "spent=$spent ($billed billed min on $size)" "rerun: $rerun"
  fi
  echo "PREGATE_REMOTE: tree=$vm_tree tests=$(field tests "$result") failed=$(field failed "$result") spent=$spent"
  exit $(( rc == 0 ? 0 : 1 ))
fi
vm=$(sed -n 's/^[0-9]* ubi-runner: creating \([^ ]*\) .*/\1/p' "$log" | tail -1)
down=$(grep -E 'ubi-runner: (destroyed|gone:|WARNING|FAILED to destroy)' "$log" | tail -1 | cut -d' ' -f2- || true)
cause=$(grep -E 'ubi-runner: ' "$log" | grep -vE 'ubi-runner: (destroyed|gone:|destroy requested|waiting for an in-flight)' | tail -1 | cut -d' ' -f2- || true)
[ "$rc" -ne 124 ] || cause="the VM was told to stop after ${stop_after}s ($stop_why) and torn down"
stop 4 PREGATE_REMOTE_INFRA "infrastructure failure (ubi-runner exit $rc): ${cause:-no ubi-runner message}" \
  "VM: ${vm:-none created}${down:+; $down}" "log: $log" "spent=$spent ($billed billed min on $size)"
}
