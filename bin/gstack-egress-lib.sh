# gstack-egress-lib.sh — shared egress-receipt helpers for bash sinks.
#
# This file is NOT executable; source it:
#
#   . "$(dirname "$0")/gstack-egress-lib.sh"
#
# THREAT MODEL: the egress ledger is forensic observability — it records
# ATTEMPTED egress so accidents are auditable; it is not an exfiltration
# control. Receipts are written before send, outcomes are best-effort, and
# fail-open callers can send unrecorded with a warning.
#
# Provides:
#   _receipted_curl <closed|open> <sink> <host> <class> <consent> \
#       (<payload-file>|--no-payload) <curl-cmd> [args...]
#     — Writes an egress receipt BEFORE running the wrapped curl command.
#     When a payload file is given, the receipt hashes that file and curl
#     receives THE SAME FILE via an appended `--data-binary @file`, so the
#     recorded sha256 matches the exact wire bytes (scan-at-sink precedent).
#     The payload file is CONSUMED: the helper deletes it after the send
#     (and on refusal) — callers need no cleanup trap for it.
#     stdout is the wrapped command's stdout; returns its exit code.
#     A best-effort outcome record (`exit:N`) is appended after the send;
#     the receipt id is exported as _GSTACK_EGRESS_LAST_RECEIPT so callers
#     can append a more specific outcome (e.g. the HTTP status).
#
#     Fail policy (first argument, per call):
#       closed — receipt failure REFUSES the send: nothing hits the network,
#                return 3, problem/cause/fix message on stderr.
#       open   — receipt failure warns on stderr and proceeds unrecorded.
#
#   _receipted_git <closed|open> <sink> <host> <class> <consent> <git-cmd> [args...]
#     — Same contract for git-class ops: sha256:null receipt (a subprocess
#     owns the bytes), no payload file, command runs unmodified.
#
# NO EXIT traps in this file, ever: callers (gstack-telemetry-sync) own
# their own EXIT traps and a trap set by a sourced library would clobber
# the caller's. All temp handling is immediate, per call.

# Self-locate without dirname (builtins only), so the lib works even under
# a stripped test PATH.
case "${BASH_SOURCE[0]}" in
  */*) _gstack_egress_lib_dir="$(cd "${BASH_SOURCE[0]%/*}" && pwd)" ;;
  *) _gstack_egress_lib_dir="$(pwd)" ;;
esac

_gstack_egress_home() {
  if [ -n "${GSTACK_HOME:-}" ]; then
    printf '%s' "$GSTACK_HOME"
  elif [ -n "${GSTACK_STATE_DIR:-}" ]; then
    printf '%s' "$GSTACK_STATE_DIR"
  else
    printf '%s' "$HOME/.gstack"
  fi
}

# Problem + cause + fix, in plain language (DX contract for every
# fail-closed refusal). $1 = sink, $2 = cause text from the receipt bridge.
_gstack_egress_refusal() {
  local home
  home="$(_gstack_egress_home)"
  echo "gstack: $1 NOT sent — the egress receipt could not be written (${2:-unknown cause}). Fix: chmod -R u+w $home/security (or check GSTACK_HOME). What this is: gstack records everything it ATTEMPTS to send off-machine; see gstack-egress." >&2
}

# Shared core. $6 is a payload file path or --no-payload; the rest is the
# command to run. Payload files are deleted here (immediate, no traps).
_gstack_egress_run() {
  local policy="$1" sink="$2" host="$3" class="$4" consent="$5" payload="$6"
  shift 6
  local bin="$_gstack_egress_lib_dir/gstack-egress-receipt"

  local payload_flag=(--no-payload)
  [ "$payload" != "--no-payload" ] && payload_flag=(--payload-file "$payload")

  local receipt_id="" receipt_err="" err_file=""
  err_file="$(mktemp "${TMPDIR:-/tmp}/gstack-egress-err-XXXXXX" 2>/dev/null)" || err_file=""
  if [ -n "$err_file" ]; then
    receipt_id="$("$bin" write --sink "$sink" --host "$host" --class "$class" \
      "${payload_flag[@]}" --consent "$consent" 2>"$err_file")" || receipt_id=""
    receipt_err="$(head -c 500 "$err_file" 2>/dev/null | tr '\n' ' ')"
    rm -f "$err_file"
  else
    receipt_id="$("$bin" write --sink "$sink" --host "$host" --class "$class" \
      "${payload_flag[@]}" --consent "$consent" 2>/dev/null)" || receipt_id=""
  fi
  _GSTACK_EGRESS_LAST_RECEIPT="$receipt_id"

  if [ -z "$receipt_id" ]; then
    if [ "$policy" = "closed" ]; then
      _gstack_egress_refusal "$sink" "$receipt_err"
      [ "$payload" != "--no-payload" ] && rm -f "$payload"
      return 3
    fi
    echo "gstack: egress receipt could not be written for $sink (${receipt_err:-unknown cause}) — sending anyway (fail-open). gstack normally records everything it ATTEMPTS to send off-machine; see gstack-egress." >&2
  fi

  local status=0
  if [ "$payload" = "--no-payload" ]; then
    "$@" || status=$?
  else
    "$@" --data-binary @"$payload" || status=$?
    rm -f "$payload"
  fi

  if [ -n "$receipt_id" ]; then
    "$bin" outcome "$receipt_id" "exit:$status" 2>/dev/null || true
  fi
  return $status
}

_receipted_curl() {
  _gstack_egress_run "$@"
}

_receipted_git() {
  local policy="$1" sink="$2" host="$3" class="$4" consent="$5"
  shift 5
  _gstack_egress_run "$policy" "$sink" "$host" "$class" "$consent" --no-payload "$@"
}
