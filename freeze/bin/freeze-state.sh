#!/usr/bin/env bash
set -euo pipefail

_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$_here/../../careful/bin/hook-extract.sh"
STATE_DIR="$(gstack_hook_state_root; printf x)"; STATE_DIR="${STATE_DIR%x}"
mkdir -p "$STATE_DIR"
STATE_DIR="$(cd "$STATE_DIR" && pwd -P && printf x)"; STATE_DIR="${STATE_DIR%$'\nx'}"
state="$STATE_DIR/freeze-dir.txt"
mutex="$STATE_DIR/.freeze-mutation.lock"
action="${1:-}"
case "$action" in acquire|set|release|clear) ;; *) echo 'Usage: freeze-state.sh acquire|set DIRECTORY | release OWNER | clear' >&2; exit 2 ;; esac

if ! mkdir "$mutex" 2>/dev/null; then
  echo 'FREEZE_BUSY: another writer or an interrupted mutation owns the state lock. Retry after it finishes; if abandoned, inspect it with the user before recovery. No boundary changed.' >&2
  exit 1
fi
temp=""
finish() {
  local rc=$?
  [ -z "$temp" ] || rm -f -- "$temp"
  rmdir "$mutex"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$action" = acquire ] && { [ -e "$state" ] || [ -L "$state" ]; }; then
  echo 'FREEZE_PRESERVED: an existing boundary belongs to the user or another run. Do not release it; use /freeze to re-establish an ambiguous legacy boundary with the user.'
  exit 0
fi
if [ -L "$state" ] || { [ -e "$state" ] && [ ! -f "$state" ]; }; then
  echo 'FREEZE_PRESERVED: unexpected state type; inspect it with the user before recovery.' >&2
  exit 1
fi
case "$action" in
  acquire|set)
    boundary="$(cd -- "${2:?Directory required}" && pwd -P && printf x)"; boundary="${boundary%$'\nx'}"
    case "$boundary" in *$'\n'*|*$'\r'*) echo 'FREEZE_ERROR: boundary must fit on one line.' >&2; exit 2 ;; esac
    owner="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"
    [ "${#owner}" -eq 32 ] || exit 1
    temp="$(mktemp "$STATE_DIR/.freeze-write.XXXXXX")"
    printf '%s\ngstack-freeze-v1:%s\n' "$boundary" "$owner" > "$temp"
    mv -f -- "$temp" "$state"
    temp=""
    printf 'FREEZE_OWNER=%s\nFREEZE_DIR=%s\n' "$owner" "$boundary"
    ;;
  release)
    owner="${2:?Owner required}"
    case "$owner" in ''|*[!a-f0-9]*) echo 'FREEZE_ERROR: invalid owner token.' >&2; exit 2 ;; esac
    [ "${#owner}" -eq 32 ] || exit 2
    if [ -f "$state" ] && [ "$(sed -n '2p' "$state")" = "gstack-freeze-v1:$owner" ]; then
      rm -- "$state"
      echo 'FREEZE_RELEASED: investigation-owned boundary removed.'
    else
      echo 'FREEZE_PRESERVED: no matching owner; existing or replacement state was left untouched.'
    fi
    ;;
  clear)
    rm -f -- "$state"
    echo 'FREEZE_CLEARED: user-requested edit boundary removal completed.'
    ;;
esac
