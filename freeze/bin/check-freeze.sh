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

# A deny for a path whose landing spot cannot be worked out: never fall back
# to comparing the raw string (that fallback was the fail-open in #3623).
_freeze_unresolved() {
  gstack_hook_log_fire freeze boundary_deny
  gstack_hook_decision deny "[freeze] Blocked: cannot tell where $1 lands ($2), so the freeze boundary cannot be checked (fail closed). Use a plain absolute path, or run /unfreeze to remove the boundary."
  _FREEZE_DECIDED=1
  exit 0
}

# Windows path rules apply on Windows bash and to drive-letter or UNC paths
# on any platform (the normalizer rewrites those everywhere): there '..'
# never climbs above X:\ or \\server\share, and names lose trailing dots
# and spaces.
_freeze_win_shaped() {
  [ "$GSTACK_HOOK_IS_WINDOWS" = 1 ] && return 0
  case "$1" in
    [A-Za-z]:[\\/]*|[A-Za-z]:|\\\\[!\\/]*) return 0 ;;
  esac
  return 1
}

# Both sides of the comparison go through one canonicalization: the state
# file may hold C:\dev\proj\ or the /c/dev/proj/ that `pwd` prints in Git
# Bash, and Claude Code on Windows reports file_path as C:\... (#2876).
FREEZE_DIR_WIN=0
if _freeze_win_shaped "$FREEZE_DIR"; then FREEZE_DIR_WIN=1; fi
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

# bash 3.2 expands $'...' only outside double quotes, so keep these in
# variables for use inside parameter expansions.
_FREEZE_NL=$'\n'
_FREEZE_CR=$'\r'

# No real file name holds a line break, and command substitution would drop
# a trailing one ('<b>\n' is a sibling of the boundary, not the boundary).
case "$FILE_PATH" in
  *"$_FREEZE_NL"*|*"$_FREEZE_CR"*) _freeze_unresolved "$TOOL_LABEL $FILE_PATH" "a line break in the path" ;;
esac
# The walk below costs time quadratic in the path length, and a hook that
# outlives the host's timeout lets the edit through. No real path is longer
# than PATH_MAX (4096 on Linux), so bound the work before it starts.
if [ "${#FILE_PATH}" -gt 4096 ]; then
  _freeze_unresolved "$TOOL_LABEL path of ${#FILE_PATH} characters" "longer than 4096 characters"
fi

# A leading ~ is the home directory to the host's file tools, never a
# directory named '~' under cwd: joined onto cwd, '~/.zshrc' passed whenever
# cwd sat inside the boundary (#3623). Windows bash also writes '~\'.
case "$FILE_PATH" in
  "~") FILE_PATH="$HOME" ;;
  "~/"*) FILE_PATH="$HOME/${FILE_PATH#\~/}" ;;
  "~\\"*) if [ "$GSTACK_HOOK_IS_WINDOWS" = 1 ]; then FILE_PATH="$HOME/${FILE_PATH#\~?}"; fi ;;
esac

# 'C:', 'C:x' and 'C:..\x' are relative to drive C's own working directory, and
# '\c\dev' to the current drive's root; this hook sees neither, and the
# normalizer would read them as cwd-relative or as drive C.
if [ "$GSTACK_HOOK_IS_WINDOWS" = 1 ]; then
  case "$FILE_PATH" in
    [A-Za-z]:|[A-Za-z]:[!\\/]*) _freeze_unresolved "$TOOL_LABEL $FILE_PATH" "a drive-relative path" ;;
    \\[!\\]*) _freeze_unresolved "$TOOL_LABEL $FILE_PATH" "a path relative to the current drive's root" ;;
  esac
fi

FILE_PATH_WIN=0
if _freeze_win_shaped "$FILE_PATH"; then FILE_PATH_WIN=1; fi
# Canonicalize before the absolute test: a drive-letter path does not start
# with '/', so it used to be joined onto cwd and every edit was denied.
gstack_hook_normalize_path "$FILE_PATH"
FILE_PATH="$GSTACK_HOOK_PATH"

# Resolve file_path to absolute if it isn't already, against the physical
# cwd the host process has (a logical $PWD through a symlink differs, and
# command substitution would drop a trailing newline from either).
case "$FILE_PATH" in
  /*) ;; # already absolute
  *)
    _FREEZE_PWD=$(pwd -P && printf x) || _freeze_unresolved "$TOOL_LABEL $FILE_PATH" "the working directory cannot be read"
    _FREEZE_PWD="${_FREEZE_PWD%"$_FREEZE_NL"x}"
    case "$_FREEZE_PWD" in
      *"$_FREEZE_NL"*|*"$_FREEZE_CR"*) _freeze_unresolved "$TOOL_LABEL $FILE_PATH" "a line break in the working directory" ;;
    esac
    FILE_PATH="$_FREEZE_PWD/$FILE_PATH"
    ;;
esac

# Resolve an absolute path to where a write would land (bash 3.2 builtins
# plus readlink). Components are walked left to right: empty and '.' drop,
# '..' pops, and a symlink at ANY depth is replaced by its target, even when
# the rest of the path does not exist yet. The old resolver followed only the
# final component and ran 'cd && pwd -P' on the immediate parent, comparing
# the raw string when that parent did not exist, so '<b>/../x/new/f',
# '<b>/link-out/new/f' and '<b>/..' all passed (#3623). The walk also replaces
# a per-line sed squeeze that let a newline split '..' off a name.
#   $2 lexical: apply '..' to the text and follow no symlink, the reading of a
#      path normalizer such as Node's path.resolve.
#   $3 1: Windows rules ('..' stops at /c or //server/share; link targets
#      use Windows syntax; a name ending in a dot or space, which Windows
#      trims, three leading slashes, and a UNC server or share of '', '.',
#      '..' or '?' cannot be placed). Without it a target like 'C:\..' is one
#      POSIX file name. On a POSIX host a Windows path names no local file,
#      so it is resolved as text and no local symlink is followed.
# Returns 1 for a symlink loop, a chain over 40 links, an unreadable or
# line-broken link, a Windows link target relative to a drive or its root,
# link targets that add up past 8192 characters with the path (the walk is
# quadratic, so its total input stays bounded), or an unplaceable Windows
# name; the caller fails closed.
_resolve_path() {
  local _rem="$1" _win="${3:-0}" _lead="" _cur="" _n=0 _min=0 _reroot=1
  local _part _tgt _p _tail="" _hops=0 _probe=1 _budget="${#1}"
  if [ "$_win" = 1 ] && [ "$GSTACK_HOOK_IS_WINDOWS" != 1 ]; then _probe=0; fi
  while :; do
    if [ "$_reroot" = 1 ]; then
      _reroot=0; _lead=""; _cur=""; _n=0; _min=0
      case "$_rem" in
        ///*)
          if [ "$_win" = 1 ]; then return 1; fi
          while [ "${_rem#/}" != "$_rem" ]; do _rem="${_rem#/}"; done
          ;;
        //[!/]*)
          if [ "$_win" = 1 ]; then
            _lead="/"; _rem="${_rem#//}"; _min=2
          else
            _rem="${_rem#//}"
          fi
          ;;
        *)
          while [ "${_rem#/}" != "$_rem" ]; do _rem="${_rem#/}"; done
          if [ "$_win" = 1 ]; then
            case "$_rem" in [A-Za-z]|[A-Za-z]/*) _min=1 ;; esac
          fi
          ;;
      esac
    fi
    [ -n "$_rem" ] || break
    _part="${_rem%%/*}"
    case "$_rem" in */*) _rem="${_rem#*/}" ;; *) _rem="" ;; esac
    if [ "$_win" = 1 ] && [ -n "$_lead" ] && [ "$_n" -lt 2 ]; then
      case "$_part" in ''|.|..|'?') return 1 ;; esac
    fi
    case "$_part" in
      ''|.) continue ;;
      ..)
        if [ "$_n" -gt "$_min" ]; then _cur="${_cur%/*}"; _n=$((_n - 1)); fi
        continue
        ;;
    esac
    if [ "$_win" = 1 ]; then
      case "$_part" in *[.\ ]) return 1 ;; esac
    fi
    if [ "${2:-}" = lexical ] || [ "$_probe" = 0 ] || [ ! -L "$_lead$_cur/$_part" ]; then
      _cur="$_cur/$_part"; _n=$((_n + 1))
      continue
    fi
    _hops=$((_hops + 1))
    [ "$_hops" -le 40 ] || return 1
    _tgt=$(readlink "$_lead$_cur/$_part" && printf x) || return 1
    _tgt="${_tgt%x}"; _tgt="${_tgt%"$_FREEZE_NL"}"
    case "$_tgt" in ''|*"$_FREEZE_NL"*|*"$_FREEZE_CR"*) return 1 ;; esac
    if [ "$_win" = 1 ]; then
      case "$_tgt" in [A-Za-z]:|[A-Za-z]:[!\\/]*|\\|\\[!\\]*) return 1 ;; esac
      gstack_hook_normalize_path "$_tgt"
      _tgt="$GSTACK_HOOK_PATH"
    fi
    case "$_tgt" in /*) _reroot=1 ;; esac
    _budget=$((_budget + ${#_tgt}))
    [ "$_budget" -le 8192 ] || return 1
    _rem="${_tgt%/}${_rem:+/$_rem}"
  done
  _p="$_lead$_cur"
  if [ "${2:-}" != lexical ] && [ "$_probe" = 1 ]; then
    # pwd -P on the deepest existing directory answers in the platform's own
    # dialect (/cygdrive/c/... on Cygwin) and sees links -L misses there.
    while [ -n "$_cur" ] && [ ! -d "$_lead$_cur" ]; do
      _tail="/${_cur##*/}$_tail"
      _cur="${_cur%/*}"
    done
    if [ -n "$_cur" ]; then
      if _p=$(cd "$_lead$_cur" 2>/dev/null && pwd -P && printf x); then
        _p="${_p%"$_FREEZE_NL"x}"
        case "$_p" in *"$_FREEZE_NL"*|*"$_FREEZE_CR"*) return 1 ;; esac
      else
        _p="$_lead$_cur"
      fi
      _p="${_p%/}$_tail"
    else
      _p="$_lead$_tail"
    fi
    # Git Bash spells one folder several ways through its mounts (/tmp is
    # %TEMP%, and HOME converts through them); cygpath -m gives the one drive
    # spelling Claude Code reports.
    if [ -n "$_p" ] && [ "$GSTACK_HOOK_IS_WINDOWS" = 1 ] && command -v cygpath >/dev/null 2>&1; then
      _p=$(cygpath -m "$_p" && printf x) || return 1
      _p="${_p%"$_FREEZE_NL"x}"
      case "$_p" in ''|*"$_FREEZE_NL"*|*"$_FREEZE_CR"*) return 1 ;; esac
    fi
  fi
  [ -n "$_p" ] || _p="/"
  gstack_hook_normalize_path "$_p"
  printf '%s' "$GSTACK_HOOK_PATH"
}

_FREEZE_WHY="a symlink loop, a chain over 40 links, a path and link targets over 8192 characters in all, an unreadable link, a Windows link target relative to a drive or its root, or a Windows name that cannot be placed"
FREEZE_DIR_RAW="$FREEZE_DIR"
FREEZE_DIR=$(_resolve_path "$FREEZE_DIR_RAW" physical "$FREEZE_DIR_WIN") || _freeze_unresolved "the freeze boundary $FREEZE_DIR_RAW" "$_FREEZE_WHY"
# Hosts disagree on '<link>/..': the OS means the target's parent, a lexical
# normalizer means the link's parent. The edit is inside only when both
# readings land inside the boundary.
FILE_PATH_RAW="$FILE_PATH"
FILE_PATH=$(_resolve_path "$FILE_PATH_RAW" physical "$FILE_PATH_WIN") || _freeze_unresolved "$TOOL_LABEL $FILE_PATH_RAW" "$_FREEZE_WHY"
FILE_PATH_LEXICAL=$(_resolve_path "$FILE_PATH_RAW" lexical "$FILE_PATH_WIN") || _freeze_unresolved "$TOOL_LABEL $FILE_PATH_RAW" "$_FREEZE_WHY"
FILE_PATH_LEXICAL=$(_resolve_path "$FILE_PATH_LEXICAL" physical "$FILE_PATH_WIN") || _freeze_unresolved "$TOOL_LABEL $FILE_PATH_RAW" "$_FREEZE_WHY"

# Check: does the file path start with the freeze directory? Windows paths
# are case-insensitive, so compare that way there.
[ "$GSTACK_HOOK_IS_WINDOWS" = 1 ] && shopt -s nocasematch
_freeze_inside() {
  case "$1" in
    "${FREEZE_DIR%/}/"*|"${FREEZE_DIR}") return 0 ;;
  esac
  return 1
}
if _freeze_inside "$FILE_PATH" && _freeze_inside "$FILE_PATH_LEXICAL"; then
  # Inside freeze boundary — allow
  _FREEZE_DECIDED=1
  echo '{}'
else
  # Outside freeze boundary — deny
  # Log hook fire event (shared helper respects GSTACK_HOME)
  gstack_hook_log_fire freeze boundary_deny
  if _freeze_inside "$FILE_PATH"; then FILE_PATH="$FILE_PATH_LEXICAL"; fi
  _FREEZE_SHOWN="$FILE_PATH_RAW"
  if [ "$FILE_PATH" != "$FILE_PATH_RAW" ]; then _FREEZE_SHOWN="$FILE_PATH_RAW (lands at $FILE_PATH)"; fi

  # The reason is JSON-encoded by the shared helper. Never interpolate paths
  # into hand-built JSON: a path containing a quote or newline produced
  # malformed JSON here, and the deny silently no-oped.
  gstack_hook_decision deny "[freeze] Blocked: $TOOL_LABEL $_FREEZE_SHOWN is outside the freeze boundary ($FREEZE_DIR). Only edits within the frozen directory are allowed; run /unfreeze to remove the boundary."
  _FREEZE_DECIDED=1
fi
