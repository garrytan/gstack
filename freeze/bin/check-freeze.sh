#!/usr/bin/env bash
# check-freeze.sh — PreToolUse hook for /freeze skill
# Reads JSON from stdin, checks if the edited path is within the freeze
# boundary: file_path for Edit/Write, notebook_path for NotebookEdit (#3067).
# Returns a PreToolUse hookSpecificOutput with permissionDecision "deny" to block,
# or {} to allow. The decision MUST be nested under hookSpecificOutput — Claude
# Code ignores a top-level permissionDecision, which silently no-ops the block.
#
# Polarity: freeze is a DENY-tier hook, so an unreadable payload DENIES
# (fail closed). A payload that parses but has no file_path is a non-file
# tool — allow. This is the opposite edge-handling from careful's ask-tier
# and intentionally so: /guard runs both, and a boundary that fails open is
# not a boundary.
set -euo pipefail

# Deny-tier backstop: any unexpected non-zero death (a failing pipeline under
# set -e, a deleted cwd, EACCES) would otherwise exit with no decision JSON,
# which Claude Code treats as non-blocking — the edit proceeds. Every
# deliberate output below sets _FREEZE_DECIDED first so a late failure after
# a decision never prints a second JSON object.
_FREEZE_DECIDED=""
_freeze_backstop() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$_FREEZE_DECIDED" ]; then
    _FREEZE_DECIDED=1
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[freeze] Hook failed unexpectedly (exit %s) - blocked, fail closed. Re-run ./setup or /unfreeze."}}\n' "$rc"
    exit 0
  fi
}
trap _freeze_backstop EXIT

# Read stdin
INPUT=$(cat)

# Shared JSON helpers (extractor + encoder) — one copy for careful AND freeze.
# freeze previously carried its own grep-first extractor which truncated at
# escaped quotes and failed OPEN; the shared file kills that drift class.
_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=careful/bin/hook-extract.sh
# Freeze is deny-tier: if its own helpers are missing/broken (partial install,
# mid-upgrade state), the boundary must fail CLOSED — inline JSON, since the
# encoder we would normally use lives in the file that just failed to load.
# NOTE: bash treats `.` on a MISSING file as fatal in non-interactive shells
# (an if-guard cannot catch it) — the existence check must come first.
_HOOK_HELPER="$_HOOK_DIR/../../careful/bin/hook-extract.sh"
if [ ! -f "$_HOOK_HELPER" ] || ! . "$_HOOK_HELPER" 2>/dev/null; then
  _FREEZE_DECIDED=1
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[freeze] Hook helpers unavailable (broken install?) - blocked, fail closed. Reinstall gstack or run /unfreeze."}}\n'
  exit 0
fi

# Locate the freeze directory state file. The writer (/freeze via
# gstack-paths) and this reader MUST resolve the same root or the boundary
# fails open: with GSTACK_HOME set, /freeze wrote freeze-dir.txt under
# GSTACK_HOME while this hook read $HOME/.gstack, found nothing, and allowed
# everything (#1459, #1509). gstack_hook_state_root mirrors gstack-paths.
# A helper from an older install that lacks the function must fail CLOSED
# (the existence check above only proves the file sourced), never exit 127
# with no JSON — Claude Code treats that as non-blocking.
if ! command -v gstack_hook_state_root >/dev/null 2>&1 || ! command -v gstack_hook_normalize_path >/dev/null 2>&1 || ! command -v gstack_hook_extract_tool >/dev/null 2>&1; then
  _FREEZE_DECIDED=1
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[freeze] Hook helpers out of date (partial upgrade?) - blocked, fail closed. Re-run ./setup or /unfreeze."}}\n'
  exit 0
fi
STATE_DIR="$(gstack_hook_state_root; printf x)"; STATE_DIR="${STATE_DIR%x}"
FREEZE_FILE="$STATE_DIR/freeze-dir.txt"

# If no freeze file exists, allow everything (not yet configured)
if [ ! -f "$FREEZE_FILE" ]; then
  _FREEZE_DECIDED=1
  echo '{}'
  exit 0
fi

{
  IFS= read -r FREEZE_DIR || true
  IFS= read -r FREEZE_OWNER_LINE || true
} < "$FREEZE_FILE"
case "$FREEZE_OWNER_LINE" in
  gstack-freeze-v1:*) ;;
  *) FREEZE_DIR=$(printf '%s\n' "$FREEZE_DIR" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//') ;;
esac
# A literal leading ~ in the state file never matches absolute tool paths
# (tilde is not expanded from variables) — expand it here.
case "$FREEZE_DIR" in
  "~/"*) FREEZE_DIR="$HOME/${FREEZE_DIR#\~/}" ;;
  "~") FREEZE_DIR="$HOME" ;;
esac

# If freeze dir is empty, allow
if [ -z "$FREEZE_DIR" ]; then
  _FREEZE_DECIDED=1
  echo '{}'
  exit 0
fi

# Both sides of the comparison go through one canonicalization: the state
# file may hold C:\dev\proj\ or the /c/dev/proj/ that `pwd` prints in Git
# Bash, and Claude Code on Windows reports file_path as C:\... (#2876).
gstack_hook_normalize_path "$FREEZE_DIR"
FREEZE_DIR="$GSTACK_HOOK_PATH"

case "$FREEZE_DIR" in
  /*) ;;
  *)
    gstack_hook_decision deny '[freeze] Legacy relative boundary is ambiguous. Re-run /freeze with an absolute directory chosen by the user; the saved state was preserved.'
    _FREEZE_DECIDED=1
    exit 0
    ;;
esac

# Extract the edited path with the shared real-JSON parser. Edit and Write
# carry tool_input.file_path; NotebookEdit carries tool_input.notebook_path
# (Claude Code Agent SDK reference, NotebookEditInput), so a notebook edit
# used to parse as "no path" and pass every boundary.
set +e
gstack_hook_extract_tool "$INPUT" file_path notebook_path
EXTRACT_RC=$?
set -e
FILE_PATH="$GSTACK_HOOK_VALUE"
TOOL_LABEL="${GSTACK_HOOK_TOOL:+$GSTACK_HOOK_TOOL }$GSTACK_HOOK_FIELD"

# Unparseable payload (or no parser available): DENY. A boundary hook that
# allows what it cannot read is not a boundary.
if [ "$EXTRACT_RC" -ne 0 ] && [ -n "$INPUT" ]; then
  gstack_hook_decision deny "[freeze] Could not parse the tool payload to check the freeze boundary. Blocked (fail closed). Freeze boundary: $FREEZE_DIR"
  _FREEZE_DECIDED=1
  exit 0
fi

# Parsed fine but no path field: a non-file tool payload — allow.
if [ -z "$FILE_PATH" ]; then
  _FREEZE_DECIDED=1
  echo '{}'
  exit 0
fi

# Canonicalize before the absolute test: a drive-letter path does not start
# with '/', so it used to be joined onto cwd and every edit was denied.
gstack_hook_normalize_path "$FILE_PATH"
FILE_PATH="$GSTACK_HOOK_PATH"

# Resolve file_path to absolute if it isn't already
case "$FILE_PATH" in
  /*) ;; # already absolute
  *)
    FILE_PATH="$(pwd)/$FILE_PATH"
    ;;
esac

# Normalize: remove double slashes and trailing slash. A leading '//' is a UNC
# host (//server/share) and is kept, or the check would compare a local path.
_FP_LEAD=""
case "$FILE_PATH" in
  //[!/]*) _FP_LEAD="/" ;;
esac
FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's|/\+|/|g;s|/$||')
FILE_PATH="$_FP_LEAD$FILE_PATH"
[ -n "$FILE_PATH" ] || FILE_PATH="/"

# Resolve symlinks and .. sequences (POSIX-portable, works on macOS).
# The FULL path is resolved, including the FINAL component: the previous
# version resolved only the parent directory, so an in-boundary symlink
# pointing at an out-of-boundary target sailed through the check while the
# actual write landed outside the boundary. A final component that is a
# symlink is followed (bounded, cycle-safe) so the TARGET gets checked; a
# final component that does not exist yet (new file) has nothing to follow
# and parent resolution is the correct behavior.
_resolve_path() {
  local _p="$1" _dir _base _tgt _i=0
  while [ -L "$_p" ] && [ "$_i" -lt 40 ]; do
    _tgt=$(readlink "$_p" 2>/dev/null) || break
    case "$_tgt" in
      /*) _p="$_tgt" ;;
      *) _p="$(dirname "$_p")/$_tgt" ;;
    esac
    _i=$((_i + 1))
  done
  _dir="$(dirname "$_p")"
  _base="$(basename "$_p")"
  if [ "$_base" = / ]; then printf '/'; return; fi
  _dir="$(cd "$_dir" 2>/dev/null && pwd -P || printf '%s' "$_dir")"
  # pwd -P answers in the platform's own dialect (/cygdrive/c/... on Cygwin).
  gstack_hook_normalize_path "${_dir%/}/$_base"
  printf '%s' "$GSTACK_HOOK_PATH"
}
FILE_PATH=$(_resolve_path "$FILE_PATH")
FREEZE_DIR=$(_resolve_path "$FREEZE_DIR")

# Check: does the file path start with the freeze directory? Windows paths
# are case-insensitive, so compare that way there.
[ "$GSTACK_HOOK_IS_WINDOWS" = 1 ] && shopt -s nocasematch
case "$FILE_PATH" in
  "${FREEZE_DIR%/}/"*|"${FREEZE_DIR}")
    # Inside freeze boundary — allow
    _FREEZE_DECIDED=1
    echo '{}'
    ;;
  *)
    # Outside freeze boundary — deny
    # Log hook fire event (shared helper respects GSTACK_HOME)
    gstack_hook_log_fire freeze boundary_deny

    # The reason is JSON-encoded by the shared helper. Never interpolate paths
    # into hand-built JSON: a path containing a quote or newline produced
    # malformed JSON here, and the deny silently no-oped.
    gstack_hook_decision deny "[freeze] Blocked: $TOOL_LABEL $FILE_PATH is outside the freeze boundary ($FREEZE_DIR). Only edits within the frozen directory are allowed; run /unfreeze to remove the boundary."
    _FREEZE_DECIDED=1
    ;;
esac
