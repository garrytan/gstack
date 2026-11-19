#!/usr/bin/env bash
# check-careful.sh — PreToolUse hook for /careful skill
# Reads JSON from stdin, checks a Bash or PowerShell command for destructive
# patterns (best-effort string matching, not a security boundary).
# Two tiers:
#   HIGH   — a few catastrophic shapes return "deny" in any command shape
#            (best-effort advisory hard-stop, not a policy boundary).
#   MEDIUM — the destructive families below return "ask" (always overridable).
# The families and their scratch exceptions follow GEVA-560's replay of
# 254,322 agent commands (careful/SKILL.md lists them).
# The decision MUST be nested under hookSpecificOutput — Claude Code ignores a
# top-level permissionDecision, which silently no-ops the warning.
set -euo pipefail

# Read stdin (JSON with tool_input)
INPUT=$(cat)

# Shared JSON helpers (extractor + encoder) — one copy for careful AND freeze.
# See hook-extract.sh for the drift history that motivated the shared file.
_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=careful/bin/hook-extract.sh
# bash treats `.` on a MISSING file as fatal non-interactively; a partial
# install must degrade to an ASK (this is the ask-tier hook), never silence.
_HOOK_HELPER="$_HOOK_DIR/hook-extract.sh"
if [ ! -f "$_HOOK_HELPER" ] || ! . "$_HOOK_HELPER" 2>/dev/null; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[careful] Hook helpers unavailable (broken install?) - cannot safety-check this command. Approve only if you know what it does."}}\n'
  exit 0
fi

# Extract the "command" field value from tool_input with a real JSON parser.
#
# The previous extractor was
#   grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"'
# whose [^"]* stops at the first escaped quote in the JSON string value. Any
# destructive command preceded by a quoted argument was therefore truncated
# away before the pattern checks ever ran:
#
#   git commit -m "wip" && rm -rf /   ->  CMD='git commit -m \'   -> allowed
#   bash -c "rm -rf /"                ->  CMD='bash -c \'         -> allowed
#   echo "x"; rm -rf ~                ->  CMD='echo \'            -> allowed
#
# Parse the payload properly instead, and fail CLOSED when it cannot be parsed
# at all — a hook that gates destructive commands must not allow-by-default on
# unreadable input.
#
# The same parser call reads tool_name: the PowerShell tool (Claude Code's
# primary shell on Windows, and the only one without Git Bash) carries its
# command in the same tool_input.command field as Bash (hooks reference,
# "PreToolUse > PowerShell"). An older hook-extract.sh without the combined
# reader (partial upgrade) still checks the command, as Bash.
TOOL_NAME=""
set +e
if command -v gstack_hook_extract_tool >/dev/null 2>&1; then
  gstack_hook_extract_tool "$INPUT" command
  EXTRACT_RC=$?
  TOOL_NAME="$GSTACK_HOOK_TOOL"
  CMD="$GSTACK_HOOK_VALUE"
else
  CMD=$(gstack_hook_extract_field "$INPUT" command)
  EXTRACT_RC=$?
fi
set -e

# No parser available, or the payload is not parseable JSON. Fail closed.
if [ "$EXTRACT_RC" -ne 0 ] && [ -n "$INPUT" ]; then
  gstack_hook_decision ask "[careful] Could not parse the tool payload to safety-check this command. Approve only if you know what it does."
  exit 0
fi

# Parsed fine, but there is genuinely no command field (non-shell payload) — allow.
if [ -z "$CMD" ]; then
  echo '{}'
  exit 0
fi

# Log a hook fire event (pattern name only, never command content).
# Shared helper respects GSTACK_HOME, so tests never write real analytics.
_careful_log_fire() { gstack_hook_log_fire careful "$1"; }

# A bug in the checks below (set -e stopping on an unexpected status) must
# fail toward an ask, never toward silence, which Claude Code reads as allow.
trap '_careful_rc=$?; if [ "$_careful_rc" -ne 0 ]; then gstack_hook_decision ask "[careful] The destructive-command check failed on this command (exit $_careful_rc), so it could not be checked. Approve only if you know what it does."; exit 0; fi' EXIT

# Normalize: lowercase for case-insensitive SQL matching
CMD_LOWER=$(printf '%s' "$CMD" | tr '[:upper:]' '[:lower:]')

# --- Shell-obfuscation tripwire ---
# Every check below inspects the command as a STRING, but bash executes what the
# string MEANS after expansion. ${IFS} holds the default field separator and
# contains no literal whitespace, so
#
#   rm${IFS}-rf${IFS}/
#
# matches none of the `rm\s+` patterns while executing as a full recursive
# delete. The same holds for a command assembled by a base64 decode piped to a
# shell. Rather than try to out-parse bash, treat these splitting/decoding
# primitives as a reason to ask: they are vanishingly rare in commands a human
# actually means to run unattended.
if grep -qE '\$\{IFS\}|\$IFS|\$\(echo[^)]*base64[^)]*\)|base64[[:space:]]+(-d|--decode)[^|]*\|[[:space:]]*(sh|bash)' <<< "$CMD" 2>/dev/null; then
  gstack_hook_decision ask "[careful] Shell obfuscation detected (IFS word-splitting or base64-to-shell). Read the command carefully before approving."
  exit 0
fi

# --- Commit-message masking (#1060) ---
# Mask quoted -m/-am/--message argument content in git commit commands so that
# descriptive commit messages do not trigger false positives. The quote-aware
# scanner lives in mask-commit-message.awk beside this hook: as a heredoc inside
# a command substitution, its quote characters are mis-parsed by bash 3.2
# (macOS /bin/bash), which made this whole hook a syntax error there. A missing
# program or an awk failure leaves the command unmasked. Every check below,
# the hard denies included, reads the masked command.
WARN=""
PATTERN=""
CMD_MEDIUM="$CMD"
CMD_MEDIUM_LOWER="$CMD_LOWER"
_MASK_AWK="$_HOOK_DIR/mask-commit-message.awk"
case "$CMD" in *git*commit*) _MAYBE_COMMIT=1 ;; *) _MAYBE_COMMIT=0 ;; esac
if [ "$_MAYBE_COMMIT" -eq 1 ] && [ -f "$_MASK_AWK" ]; then
  if _cmd_masked=$(printf '%s' "$CMD" | awk -f "$_MASK_AWK" 2>/dev/null); then
    CMD_MEDIUM="$_cmd_masked"
    CMD_MEDIUM_LOWER=$(printf '%s' "$CMD_MEDIUM" | tr '[:upper:]' '[:lower:]')
  fi
fi

# --- Statement scan (GEVA-560) ---
# The command is cut into statements at ; & | ( ) backtick and newline, and
# each statement into words (one layer of quotes stripped, nothing expanded).
# Every rm, git, find, rsync, shred and unlink word starts an invocation whose
# arguments are the rest of its statement, wherever it sits: after sudo,
# xargs, bash -c '...' or another command. Builtins only (bash 3.2) apart from
# one awk call that cuts the statements, and git, which runs only after a force-push or a discard of uncommitted
# work has already matched.
_NL=$'\n'
_BT='`'
_NS="[^;&|${_NL}]*"
_RX_VAR='^[$][{]?([A-Za-z_][A-Za-z0-9_]*)(:[?][^}]*)?[}]?(/.*)?$'
_RX_HOME='(~|[$]HOME|[$][{]HOME[}])'
_RX_TMP='^(/private)?(/tmp|/var/tmp)/[^[:space:]]+$'
_RX_CACHE="^${_RX_HOME}/(\.cache|\.npm|\.bun/install/cache|\.cargo/registry|\.local/share/uv|Library/Caches)(/|\$)"
_RX_ARTIFACT="^([^[:space:];&|#(${_BT}\$]*/)?(node_modules|\.next|dist|__pycache__|\.cache|build|\.turbo|coverage|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.eggs|\.venv|venv|[^/[:space:]]+\.egg-info)(/|/\*)?\$"
_RX_ROOT="^(/+|/+\*|${_RX_HOME}(/+|/+\*)?|/(usr|etc|var|home|opt|bin|sbin|lib|lib64|boot|root|srv|System|Users|Library|Applications|private|mnt/c|c)(/+|/+\*)?|${_RX_HOME}/(Documents|Desktop|Downloads|Library|Pictures|Movies|Music|\.ssh|\.config|\.aws|\.gnupg|\.kube)(/+|/+\*)?)\$"

_CAREFUL_CWD="${GSTACK_HOOK_CWD:-}"
[ -n "$_CAREFUL_CWD" ] || _CAREFUL_CWD="$PWD"
if command -v gstack_hook_normalize_path >/dev/null 2>&1; then
  gstack_hook_normalize_path "$_CAREFUL_CWD"
  _CAREFUL_CWD="$GSTACK_HOOK_PATH"
fi
_CAREFUL_CWD="${_CAREFUL_CWD%/}"

_TMPVARS=" "
_SCRATCH=0
_CD_SEEN=0
_CUR_DIR="$_CAREFUL_CWD"
_CH_D="$_CAREFUL_CWD"
_PIPE=0
_PL_S=0
_PL_D="$_CAREFUL_CWD"
_STK=""
_STASH_POP=0
_GIT_SUB=-1
_HI_RM_ROOT=0
_HI_DISK=0
_WIPEFS_SEEN=0
_WIPEFS_SAFE=0
_STMT_N=0
_RM_UNSAFE=0
_OUTSIDE=0
_PUSH_DENY=""
_PUSH_FORCE=0
_PUSH_DELETE=0
_HIST=0
_LOSE_NOW=""
_PEND_N=0
_S=""
_R=""
_RISK=""
_D=""

# Up to two layers of quotes, any mix: trap 'rm -rf "$T"' leaves $T.
_Q="[\"']"
_careful_strip() { _S="${1#$_Q}"; _S="${_S#$_Q}"; _S="${_S%$_Q}"; _S="${_S%$_Q}"; }

# Variables assigned from mktemp anywhere in the command (NAME=$(mktemp ...)).
_careful_find_tmpvars() {
  local s="$CMD_MEDIUM" re='(^|[[:space:];&|(])([A-Za-z_][A-Za-z0-9_]*)="?[$][(][[:space:]]*mktemp([^[:alnum:]_]|$)'
  case "$s" in *mktemp*) ;; *) return 0 ;; esac
  local name r c ra
  while [[ $s =~ $re ]]; do
    name="${BASH_REMATCH[2]}"
    s="${s#*"${BASH_REMATCH[0]}"}"
    r="$CMD_MEDIUM"; c=0; ra="(^|[[:space:];&|(])${name}[+]?="
    while [[ $r =~ $ra ]]; do c=$((c + 1)); r="${r#*"${BASH_REMATCH[0]}"}"; done
    [ "$c" -gt 1 ] || _TMPVARS="$_TMPVARS$name "
  done
  return 0
}
_careful_is_tmpvar() { case "$_TMPVARS" in *" $1 "*) return 0 ;; esac; return 1; }

# A $VAR-led word: _R is the word with VAR's value from an assignment in the
# same command, or the word unchanged with _RISK guarded (${VAR:?}) or
# unguarded (an unset VAR turns "$VAR/" into "/").
_careful_resolve() {
  _R="$1"; _RISK=""
  [[ $1 =~ $_RX_VAR ]] || return 0
  local name="${BASH_REMATCH[1]}" guard="${BASH_REMATCH[2]}" rest="${BASH_REMATCH[3]}"
  local re="(^|[[:space:];&|(])${name}=(\"(/tmp/|/var/tmp/)[^\"${_BT}(]*\"|(/tmp/|/var/tmp/)[^[:space:];&|()\"'${_BT}]*|\"[^\"\$]*\"|'[^']*'|[^[:space:];&|\$()\"'${_BT}]+)([[:space:];&|)]|\$)"
  if [[ $CMD_MEDIUM =~ $re ]]; then
    _careful_strip "${BASH_REMATCH[2]}"
    local again="(^|[[:space:];&|(])${name}=.*[[:space:];&|(]${name}="
    if [[ $CMD_MEDIUM =~ $again ]]; then _RISK=unguarded; return 0; fi
    _R="$_S$rest"
    return 0
  fi
  if [ -n "$guard" ]; then _RISK=guarded; else _RISK=unguarded; fi
  return 0
}

# Scratch a recursive delete may remove without asking: /tmp and /var/tmp,
# a mktemp variable, regenerable caches, build artifacts, and relative paths
# after a cd into scratch. Anything with a .. component is never scratch.
_careful_rm_safe() {
  local t="$1"
  if [[ $t =~ $_RX_VAR ]] && ! _careful_is_tmpvar "${BASH_REMATCH[1]}"; then _careful_resolve "$t"; t="$_R"; fi
  case "/$t/" in */../*) return 1 ;; esac
  [[ $t =~ $_RX_TMP ]] && return 0
  [[ $t =~ $_RX_CACHE ]] && return 0
  case "$t" in '$'*|'~'*) ;; *) [[ $t =~ $_RX_ARTIFACT ]] && return 0 ;; esac
  if [[ $t =~ $_RX_VAR ]] && _careful_is_tmpvar "${BASH_REMATCH[1]}"; then return 0; fi
  if [ "$_SCRATCH" -eq 1 ]; then
    case "$t" in /*|'~'*|'$'*|-*|*'`'*|*'('*|*'*'*) ;; *) return 0 ;; esac
  fi
  return 1
}

# A delete target outside the session's folder: an absolute or ~ path that is
# not scratch or a cache, a path climbing out with .., or a word led by a
# variable that may be unset.
_careful_outside() {
  local t="$1"
  [ -n "$t" ] || return 1
  case "/$t/" in */../*) return 0 ;; esac
  case "$t" in /dev/*|/proc/*|/tmp|/tmp/|/var/tmp|/var/tmp/|/private/tmp|/private/tmp/) return 1 ;; esac
  [[ $t =~ $_RX_TMP ]] && return 1
  [[ $t =~ $_RX_CACHE ]] && return 1
  if [[ $t =~ $_RX_VAR ]]; then
    _careful_is_tmpvar "${BASH_REMATCH[1]}" && return 1
    _careful_resolve "$t"
    [ "$_RISK" = unguarded ] && return 0
    [ "$_RISK" = guarded ] && return 1
    t="$_R"
    case "/$t/" in */../*) return 0 ;; esac
    [[ $t =~ $_RX_TMP ]] && return 1
    [[ $t =~ $_RX_CACHE ]] && return 1
  fi
  case "$t" in
    '~'|'~/'*) t="${HOME:-}${t#\~}" ;;
    '~'*) return 0 ;;
    /*) ;;
    *) return 1 ;;
  esac
  t="${t%/}"
  if [ -n "$_CAREFUL_CWD" ] && { [ "$t" = "$_CAREFUL_CWD" ] || [ "${t#"$_CAREFUL_CWD"/}" != "$t" ]; }; then return 1; fi
  return 0
}

# _CUR_DIR is the folder a cd leads to, or empty when it is unknown.
_careful_cd() {
  _CD_SEEN=1
  _SCRATCH=0
  case "$1" in
    '') _CUR_DIR="${HOME:-}" ;;
    -*) _CUR_DIR="" ;;
    *) _careful_join_dir "$_CUR_DIR" "$1"; _CUR_DIR="$_D" ;;
  esac
  case "/$1/" in */../*) return 0 ;; esac
  if [[ "${1%/}/x" =~ $_RX_TMP ]]; then _SCRATCH=1; fi
  if [[ $1 =~ $_RX_VAR ]] && _careful_is_tmpvar "${BASH_REMATCH[1]}"; then _SCRATCH=1; fi
  return 0
}

_careful_rm() {
  local k="$1" t rec=0 late=0 nt=0 first=1 q="" cp=1
  local tg=()
  # rm opening a quoted string (trap 'rm -rf "$T"' EXIT) ends where it closes.
  case "${RW[$((k - 1))]}" in \'*) q="'" ;; \"*) q='"' ;; esac
  # rm after a plain word (aws s3 rm, docker rm) is that tool's subcommand.
  if [ "$k" -ge 2 ] && [ -z "$q" ]; then
    case "${T[$((k - 2))]}" in
      sudo|doas|xargs|env|command|exec|nice|nohup|time|timeout|then|do|else|'!'|'{'|-*|*=*|[0-9]*) ;;
      *) case "${RW[$((k - 1))]}" in '\rm'|*/rm) ;; *) cp=0 ;; esac ;;
    esac
  fi
  while [ "$k" -lt "$n" ]; do
    t="${T[$k]}"; k=$((k + 1))
    if [ -n "$q" ]; then case "${RW[$((k - 1))]}" in *"$q") k=$n ;; esac; fi
    [ -n "$t" ] || continue
    # A subcommand named rm (aws s3 rm s3://b --recursive) is not rm: a real
    # recursive rm leads with its flags, as the original family required.
    if [ "$first" -eq 1 ]; then first=0; case "$t" in -*) ;; *) [ "$cp" -eq 1 ] || rec=2 ;; esac; fi
    case "$t" in
      --recursive) late=1; [ "$rec" -eq 2 ] || rec=1 ;;
      -*) case "${t#-}" in *[!a-zA-Z]*|'') ;; *[rR]*) late=1; [ "$rec" -eq 2 ] || rec=1 ;; esac ;;
      [0-9]'>'*|[0-9]'<'*|'>'*|'<'*) ;;
      *) tg[$nt]="$t"; nt=$((nt + 1)) ;;
    esac
  done
  if [ "$rec" -eq 1 ] && [ "$nt" -eq 0 ]; then _RM_UNSAFE=1; fi
  k=0
  while [ "$k" -lt "$nt" ]; do
    t="${tg[$k]}"; k=$((k + 1))
    # GNU rm takes flags after its operands: rm / -rf still denies.
    if [ "$late" -eq 1 ] && [[ $t =~ $_RX_ROOT ]]; then _HI_RM_ROOT=1; fi
    if [ "$rec" -eq 1 ]; then
      _careful_rm_safe "$t" || _RM_UNSAFE=1
    fi
    if [ "$_OUTSIDE" -eq 0 ] && _careful_outside "$t"; then _OUTSIDE=1; fi
  done
  return 0
}

# find -delete / -exec rm, rsync --delete, shred and unlink outside the folder.
_careful_del() {
  [ "$_OUTSIDE" -eq 0 ] || return 0
  local tool="$1" k="$2" t last="" del=0 dry=0 act=0 stop=0 hit=0 lead=1
  while [ "$k" -lt "$n" ]; do
    t="${T[$k]}"; k=$((k + 1))
    [ -n "$t" ] || continue
    case "$tool" in
      shred|unlink)
        case "$t" in -*) ;; *) if _careful_outside "$t"; then hit=1; fi ;; esac ;;
      rsync)
        case "$t" in
          --delete*) del=1 ;;
          -n|--dry-run) dry=1 ;;
          --*) ;;
          -*) case "${t#-}" in *[!a-zA-Z]*) ;; *n*) dry=1 ;; esac ;;
          [0-9]'>'*|'>'*|'<'*) ;;
          *) last="$t" ;;
        esac ;;
      find)
        if [ "$lead" -eq 1 ]; then
          case "$t" in
            -H|-L|-P|-O*) continue ;;
            -D) k=$((k + 1)); continue ;;
          esac
          lead=0
        fi
        case "$t" in
          -delete) act=1; stop=1 ;;
          -exec|-execdir)
            stop=1
            if [ "$k" -lt "$n" ]; then case "${T[$k]}" in rm|/bin/rm|/usr/bin/rm) act=1 ;; esac; fi ;;
          -*|'('|'!'|'\('|')') stop=1 ;;
          *) if [ "$stop" -eq 0 ] && _careful_outside "$t"; then hit=2; fi ;;
        esac ;;
    esac
  done
  case "$tool" in
    rsync) if [ "$del" -eq 1 ] && [ "$dry" -eq 0 ] && [ -n "$last" ] && _careful_outside "$last"; then hit=1; fi ;;
    find) if [ "$hit" -eq 2 ] && [ "$act" -eq 1 ]; then hit=1; else hit=0; fi ;;
  esac
  if [ "$hit" -eq 1 ]; then _OUTSIDE=1; fi
  return 0
}

# wipefs -a erases every signature on its targets. _RX_WIPEFS denies any
# wipefs with -a, --a, --al or --all; this scan only proves the one exemption
# on top of it. An invocation is proven when wipefs leads its statement (after
# sudo or NAME=value words); every target, with options read the way getopt
# reads them, is a plain literal path outside /dev with a disk-image suffix
# (.img, .iso, .raw, .qcow2, .vhd, .vhdx, .vmdk, .dmg) that already exists as
# a regular file, not a symlink, in a known folder; and no redirect goes into
# /dev other than /dev/null, /dev/stdout or /dev/stderr. An unproven
# invocation with -a in any spelling is HIGH here too.
_careful_wipefs() {
  local k="$1" t g j=0 all=0 hit=0 tgt=0 val=0 red=0 opts=1
  _WIPEFS_SEEN=$((_WIPEFS_SEEN + 1))
  while [ "$j" -lt $((k - 1)) ]; do
    case "${T[$j]}" in sudo|[A-Za-z_]*=*) ;; *) hit=1 ;; esac
    j=$((j + 1))
  done
  while [ "$k" -lt "$n" ]; do
    t="${T[$k]}"; k=$((k + 1))
    if [ "$val" -eq 1 ]; then val=0; continue; fi
    case "$t" in
      '') continue ;;
      '<'|'>'|'>>'|[0-9]'>'|[0-9]'>>'|[0-9]'<') red=1; continue ;;
    esac
    if [ "$red" -eq 0 ]; then
      case "$t" in [0-9]'>'*|'>'*|[0-9]'<'*|'<'*) red=1; t="${t##*[<>]}" ;; esac
    fi
    if [ "$red" -eq 1 ]; then
      red=0
      _careful_join_dir "$_CUR_DIR" "$t"
      case "$_D" in
        /dev/null|/dev/stdout|/dev/stderr) ;;
        ''|/dev|/dev/*|*/dev/*) hit=1 ;;
      esac
      continue
    fi
    if [ "$opts" -eq 1 ]; then
      case "$t" in
        --) opts=0; continue ;;
        --a|--al|--all) all=1; continue ;;
        --offset|--types|--output) val=1; continue ;;
        --*) continue ;;
        -?*)
          g="${t#-}"
          while [ -n "$g" ]; do
            case "$g" in
              a*) all=1 ;;
              [toO]) val=1; break ;;
              [toO]*) break ;;
            esac
            g="${g#?}"
          done
          continue ;;
      esac
    fi
    case "$t" in
      *[!A-Za-z0-9._/+@%,:~-]*|*/dev/*|dev/*) hit=1 ;;
      *.img|*.iso|*.raw|*.qcow2|*.vhd|*.vhdx|*.vmdk|*.dmg)
        _careful_join_dir "$_CUR_DIR" "$t"
        case "$_D" in
          ''|/dev/*) hit=1 ;;
          *) if [ -f "$_D" ] && [ ! -L "$_D" ]; then tgt=1; else hit=1; fi ;;
        esac ;;
      *) hit=1 ;;
    esac
  done
  if [ "$hit" -eq 0 ] && [ "$tgt" -eq 1 ]; then
    _WIPEFS_SAFE=$((_WIPEFS_SAFE + 1))
  elif [ "$all" -eq 1 ]; then
    _HI_DISK=1
  fi
  return 0
}

_careful_join_dir() {
  case "$2" in
    *'$'*|*'`'*) _D="" ;;
    /*) _D="$2" ;;
    '~'|'~/'*) _D="${HOME:-}${2#\~}" ;;
    *) if [ -n "$1" ]; then _D="$1/$2"; else _D=""; fi ;;
  esac
}

_careful_default_branch() {
  local b
  b=$(git -C "$1" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)
  b="${b#refs/remotes/origin/}"
  if [ -z "$b" ]; then
    if git -C "$1" show-ref --verify -q refs/remotes/origin/main 2>/dev/null; then b=main
    elif git -C "$1" show-ref --verify -q refs/remotes/origin/master 2>/dev/null; then b=master
    fi
  fi
  printf '%s' "$b"
}

# A forced push (not --force-with-lease alone) that lands on main, master or
# the default branch, named or as the current branch.
_careful_push_default() {
  local j=0 r hit="" def cur="" bare=0
  [ "$nr" -gt 0 ] || bare=1
  while [ "$j" -lt "$nr" ]; do
    r="${refs[$j]}"; j=$((j + 1))
    case "$r" in main|master) hit="$r"; break ;; HEAD) bare=1 ;; esac
  done
  if [ -z "$hit" ]; then
    def=$(_careful_default_branch "${dir:-$_CAREFUL_CWD}")
    if [ "$all" -eq 1 ] && [ -n "$dir" ]; then
      for r in main master $def; do
        if git -C "$dir" show-ref --verify -q "refs/heads/$r" 2>/dev/null; then hit="$r"; break; fi
      done
    fi
    j=0
    while [ -z "$hit" ] && [ -n "$def" ] && [ "$j" -lt "$nr" ]; do
      r="${refs[$j]}"; j=$((j + 1))
      if [ "$r" = "$def" ]; then hit="$r"; break; fi
    done
    if [ -z "$hit" ] && [ "$bare" -eq 1 ] && [ -n "$dir" ]; then
      cur=$(git -C "$dir" branch --show-current 2>/dev/null || true)
      if [ -n "$cur" ] && { [ "$cur" = main ] || [ "$cur" = master ] || [ "$cur" = "$def" ]; }; then hit="$cur"; fi
    fi
  fi
  [ -z "$hit" ] || _PUSH_DENY="$hit"
  return 0
}

_careful_push() {
  local j=0 t c r force=0 lease=0 dry=0 del=0 np=0 nr=0 repo=0 all=0 val=0
  local refs=()
  while [ "$j" -lt "$na" ]; do
    t="${a[$j]}"; j=$((j + 1))
    if [ "$val" -eq 1 ]; then val=0; continue; fi
    case "$t" in
      --force-with-lease*|--force-if-includes) lease=1 ;;
      -f|--force) force=1 ;;
      --mirror) force=1; all=1 ;;
      --all|--branches) all=1 ;;
      -n|--dry-run) dry=1 ;;
      -d|--delete) del=1 ;;
      --repo=*) repo=1 ;;
      --repo) repo=1; val=1 ;;
      --*) ;;
      -*)
        # In a short-option group, letters after o are its push-option value.
        c="${t#-}"
        case "$c" in
          *[!a-zA-Z]*) ;;
          *)
            c="${c%%o*}"
            case "$c" in *f*) force=1 ;; esac
            case "$c" in *n*) dry=1 ;; esac ;;
        esac ;;
      [0-9]'>'*|'>'*|'<'*) ;;
      *)
        np=$((np + 1))
        # With --repo the first operand may be a refspec too: read it as one.
        if [ "$np" -gt 1 ] || [ "$repo" -eq 1 ]; then
          case "$t" in '+'*) force=1 ;; :?*) del=1 ;; esac
          r="${t#+}"; r="${r##*:}"; r="${r#refs/heads/}"
          refs[$nr]="$r"; nr=$((nr + 1))
        fi ;;
    esac
  done
  [ "$dry" -eq 0 ] || return 0
  if [ "$force" -eq 1 ] && [ -z "$_PUSH_DENY" ]; then _careful_push_default; fi
  if [ "$force" -eq 1 ] || [ "$lease" -eq 1 ]; then _PUSH_FORCE=1; fi
  if [ "$del" -eq 1 ]; then _PUSH_DELETE=1; fi
  return 0
}

# Queue a check that asks only when the tree really holds work the command
# would discard (tracked changes, or what git clean -n lists). An unknown
# tree (after a cd, --work-tree, a $ or backtick argument) asks without git.
_careful_pend() {
  local kind="$1" name="$2" d="$dir" x
  shift 2
  for x in ${1+"$@"}; do case "$x" in *'$'*|*'`'*) d="" ;; esac; done
  [ "$wt" -eq 0 ] || d=""
  [ "$_STASH_POP" -eq 0 ] || d=""
  _PEND_KIND[$_PEND_N]="$kind"
  _PEND_NAME[$_PEND_N]="$name"
  _PEND_DIR[$_PEND_N]="$d"
  _PEND_ARGS[$_PEND_N]="${*:-}"
  _PEND_N=$((_PEND_N + 1))
  return 0
}

_careful_git_lose() {
  local j=0 t c force=0 dd=0 staged=0 wtree=0 dry=0 inter=0 hard=0 skip=0 np=0 nq=0 nc=0
  local pre=() post=() cargs=()
  case "$sub" in
    stash)
      case "${a[0]:-}" in
        drop|clear) _LOSE_NOW="${_LOSE_NOW:-git_stash_drop}" ;;
        pop) _STASH_POP=1 ;;
      esac
      return 0 ;;
    worktree) [ "${a[0]:-}" = remove ] || return 0 ;;
  esac
  while [ "$j" -lt "$na" ]; do
    t="${a[$j]}"; j=$((j + 1))
    if [ "$dd" -eq 1 ]; then post[$nq]="$t"; nq=$((nq + 1)); cargs[$nc]="$t"; nc=$((nc + 1)); continue; fi
    if [ "$skip" -eq 1 ]; then skip=0; cargs[$nc]="$t"; nc=$((nc + 1)); continue; fi
    case "$t" in
      --) dd=1; cargs[$nc]="$t"; nc=$((nc + 1)) ;;
      --hard) hard=1 ;;
      -f|--force|--discard-changes) force=1 ;;
      --staged) staged=1 ;;
      --worktree) wtree=1 ;;
      -n|--dry-run) dry=1 ;;
      -i|--interactive|--pathspec-from-file*) inter=1 ;;
      -q|--quiet) ;;
      -s|--source|-e|--exclude) skip=1; cargs[$nc]="$t"; nc=$((nc + 1)) ;;
      --*) cargs[$nc]="$t"; nc=$((nc + 1)) ;;
      -*)
        c="${t#-}"
        case "$c" in
          *[!a-zA-Z]*) cargs[$nc]="$t"; nc=$((nc + 1)) ;;
          *)
            case "$c" in *f*) force=1 ;; esac
            case "$c" in *n*) dry=1 ;; esac
            case "$c" in *i*) inter=1 ;; esac
            case "$c" in *S*) staged=1 ;; esac
            case "$c" in *W*) wtree=1 ;; esac
            c="${c//f/}"; c="${c//q/}"
            if [ -n "$c" ]; then cargs[$nc]="-$c"; nc=$((nc + 1)); fi ;;
        esac ;;
      *) pre[$np]="$t"; np=$((np + 1)); cargs[$nc]="$t"; nc=$((nc + 1)) ;;
    esac
  done
  case "$sub" in
    reset)
      [ "$hard" -eq 1 ] || return 0
      for c in ${pre[@]+"${pre[@]}"}; do case "$c" in *'$'*|*'`'*) dir="" ;; esac; done
      _careful_pend tracked git_reset_hard ;;
    checkout)
      if [ "$force" -eq 1 ]; then _careful_pend tracked git_discard_paths
      elif [ "$dd" -eq 1 ]; then
        if [ "$nq" -gt 0 ]; then _careful_pend tracked git_discard_paths "${post[@]}"; fi
      elif [ "$np" -gt 0 ]; then
        case "${pre[0]}" in .*) _careful_pend tracked git_discard "${pre[@]}" ;; esac
      fi ;;
    switch) if [ "$force" -eq 1 ]; then _careful_pend tracked git_discard_paths; fi ;;
    restore)
      if [ "$staged" -eq 0 ] || [ "$wtree" -eq 1 ]; then
        c=git_discard_paths
        if [ "$np" -gt 0 ]; then case "${pre[0]}" in .*) c=git_discard ;; esac; fi
        if [ "$inter" -eq 1 ]; then dir=""; fi
        _careful_pend tracked "$c" ${pre[@]+"${pre[@]}"} ${post[@]+"${post[@]}"}
      fi ;;
    clean)
      if [ "$force" -eq 1 ] && [ "$dry" -eq 0 ]; then
        if [ "$inter" -eq 1 ]; then dir=""; fi
        _careful_pend clean git_clean ${cargs[@]+"${cargs[@]}"}
      fi ;;
    worktree) if [ "$force" -eq 1 ]; then _LOSE_NOW="${_LOSE_NOW:-git_worktree_force}"; fi ;;
  esac
  return 0
}

_careful_git_hist() {
  local j=0
  case "$sub" in
    filter-branch|filter-repo)
      while [ "$j" -lt "$na" ]; do [ "${a[$j]}" = --version ] && return 0; j=$((j + 1)); done
      _HIST=1 ;;
    reflog)
      [ "${a[0]:-}" = expire ] || return 0
      while [ "$j" -lt "$na" ]; do case "${a[$j]}" in *=now|*=all) _HIST=1 ;; esac; j=$((j + 1)); done ;;
    gc)
      while [ "$j" -lt "$na" ]; do case "${a[$j]}" in --prune=now|--prune=all) _HIST=1 ;; esac; j=$((j + 1)); done ;;
  esac
  return 0
}

_careful_git() {
  local k="$1" p=0 t dir="$_CUR_DIR" wt=0 sub na=0
  local a=()
  case "$CMD_MEDIUM" in *GIT_DIR=*|*GIT_WORK_TREE=*) wt=1 ;; esac
  while [ "$p" -lt $((k - 1)) ]; do
    case "${T[$p]}" in GIT_WORK_TREE=*|GIT_DIR=*) wt=1 ;; esac
    p=$((p + 1))
  done
  while [ "$k" -lt "$n" ]; do
    t="${T[$k]}"
    case "$t" in
      -C) k=$((k + 1)); if [ "$k" -lt "$n" ]; then _careful_join_dir "$dir" "${T[$k]}"; dir="$_D"; fi ;;
      -c|--exec-path|--namespace|--config-env) k=$((k + 1)) ;;
      --git-dir|--work-tree) wt=1; k=$((k + 1)) ;;
      --git-dir=*|--work-tree=*) wt=1 ;;
      -*) ;;
      *) break ;;
    esac
    k=$((k + 1))
  done
  [ "$k" -lt "$n" ] || return 0
  sub="${T[$k]}"
  _GIT_SUB=$k
  k=$((k + 1))
  while [ "$k" -lt "$n" ]; do
    if [ -n "${T[$k]}" ]; then a[$na]="${T[$k]}"; na=$((na + 1)); fi
    k=$((k + 1))
  done
  case "$sub" in
    push) _careful_push ;;
    reset|checkout|switch|restore|clean|stash|worktree) [ "$_CD_SEEN" -eq 0 ] || dir=""; _careful_git_lose ;;
    filter-branch|filter-repo|reflog|gc) _careful_git_hist ;;
  esac
  return 0
}

# A cd into scratch holds only while every later statement is joined by &&:
# after ; || & or a newline the cd may have failed. A pipeline runs each part
# in a subshell, so a cd inside one never moves the folder, and a subshell,
# $( ) or backtick block gives back the outer folder when it closes. One awk
# pass cuts the statements (a bash pattern substitution is quadratic on long
# input) and marks each separator: \001 ( \002 ) \003 backtick \004 && \005 break
# \006 pipe.
# The stack holds four flags per level (scratch, pipe, pipeline-start scratch,
# cd seen); the folders are saved only once a cd has moved them.
_careful_pop() {
  [ -n "$_STK" ] || return 0
  local k=${#_STK} sv="${_STK#"${_STK%????}"}"
  _STK="${_STK%????}"
  _SCRATCH="${sv%???}"; sv="${sv#?}"; _PIPE="${sv%??}"; sv="${sv#?}"; _PL_S="${sv%?}"
  if [ "${sv#?}" -eq 1 ]; then
    _CUR_DIR="${_STK_D[$k]}"; _CH_D="${_STK_H[$k]}"; _PL_D="${_STK_PD[$k]}"
  else
    _CUR_DIR="$_CAREFUL_CWD"; _CH_D="$_CAREFUL_CWD"; _PL_D="$_CAREFUL_CWD"
  fi
  return 0
}
_careful_scan() {
  local s seg t i n bt=0 track=0
  s=$(printf '%s\n' "$CMD_MEDIUM" | awk '{ gsub(/[0-9]*>&|<&|&>/, ">"); gsub(/[|][|]/, "\n\005\n"); gsub(/&&/, "\n\004\n"); gsub(/[|]/, "\n\006\n"); gsub(/[;&]/, "\n\005\n"); gsub(/[(]/, "\n\001\n"); gsub(/[)]/, "\n\002\n"); gsub(/`/, "\n\003\n"); print; print "\005" }' 2>/dev/null) || s="$CMD_MEDIUM"
  local IFS="$_NL"
  set -f
  local segs=( $s )
  IFS=$' \t\n'
  case "$CMD_MEDIUM" in *cd*|*pushd*|*popd*) track=1 ;; esac
  # for over the whole array: indexing it is linear per access on bash 3.2.
  for seg in ${segs[@]+"${segs[@]}"}; do
    # With no cd, pushd or popd anywhere, the separators change no folder state.
    if [ "$track" -eq 0 ]; then case "$seg" in $'\001'|$'\002'|$'\003'|$'\004'|$'\005'|$'\006') continue ;; esac; fi
    case "$seg" in
      $'\002') _careful_pop; continue ;;
      $'\001'|$'\003')
        if [ "$seg" = $'\003' ]; then
          if [ "$bt" -eq 1 ]; then bt=0; _careful_pop; continue; fi
          bt=1
        fi
        _STK="$_STK$_SCRATCH$_PIPE$_PL_S$_CD_SEEN"
        if [ "$_CD_SEEN" -eq 1 ]; then _STK_D[${#_STK}]="$_CUR_DIR"; _STK_H[${#_STK}]="$_CH_D"; _STK_PD[${#_STK}]="$_PL_D"; fi
        _PIPE=0; _PL_S="$_SCRATCH"; _PL_D="$_CUR_DIR"; _CH_D="$_CUR_DIR"
        continue ;;
      $'\004')
        if [ "$_PIPE" -eq 1 ]; then _PIPE=0; _SCRATCH="$_PL_S"; _CUR_DIR="$_PL_D"; fi
        _PL_S="$_SCRATCH"; _PL_D="$_CUR_DIR"
        continue ;;
      $'\005')
        if [ "$_PIPE" -eq 1 ]; then _PIPE=0; _CUR_DIR="$_PL_D"; fi
        _SCRATCH=0
        [ "$_CUR_DIR" = "$_CH_D" ] || _CUR_DIR=""
        _CH_D="$_CUR_DIR"; _PL_S=0; _PL_D="$_CUR_DIR"
        continue ;;
      $'\006') _PIPE=1; _SCRATCH="$_PL_S"; _CUR_DIR="$_PL_D"; continue ;;
    esac
    case "$seg" in *[![:space:]]*) _STMT_N=$((_STMT_N + 1)) ;; esac
    case "$seg" in
      *rm*|*git*|*find*|*rsync*|*shred*|*unlink*|*cd*|*pushd*|*popd*|*wipefs*) ;;
      *) continue ;;
    esac
    n=0
    T=()
    RW=()
    for t in $seg; do
      case "$t" in '#'*) break ;; esac
      _careful_strip "$t"
      RW[$n]="$t"; T[$n]="$_S"; n=$((n + 1))
    done
    _GIT_SUB=-1
    i=0
    while [ "$i" -lt "$n" ]; do
      case "${T[$i]}" in
        cd) if [ $((i + 1)) -lt "$n" ]; then _careful_cd "${T[$((i + 1))]}"; else _careful_cd ""; fi ;;
        pushd|popd) _CD_SEEN=1; _SCRATCH=0; _CUR_DIR="" ;;
        wipefs|*/wipefs) _careful_wipefs $((i + 1)) ;;
        rm|'\rm'|*/rm|*':-rm'|*':=rm'|*':+rm') if [ "$i" -ne "$_GIT_SUB" ]; then _careful_rm $((i + 1)); fi ;;
        git|*/git) _careful_git $((i + 1)) ;;
        find|rsync|shred|unlink) _careful_del "${T[$i]}" $((i + 1)) ;;
      esac
      i=$((i + 1))
    done
  done
  set +f
  return 0
}

# Queued uncommitted-work checks, in command order: the first that would
# discard something sets the warning. git failing, or no repo, asks.
_careful_tree_dirty() {
  local kind="$1" d="$2" out
  shift 2
  if [ "$kind" = clean ]; then
    out=$(GIT_OPTIONAL_LOCKS=0 git -C "$d" clean -n ${1+"$@"} </dev/null 2>/dev/null) || return 0
  else
    out=$(GIT_OPTIONAL_LOCKS=0 git -C "$d" status --porcelain --untracked-files=no ${1+--} ${1+"$@"} </dev/null 2>/dev/null) || return 0
  fi
  [ -n "$out" ]
}
_careful_git_warn() {
  PATTERN="$1"
  case "$1" in
    git_reset_hard) WARN="Destructive: git reset --hard discards all uncommitted changes." ;;
    git_discard) WARN="Destructive: discards all uncommitted changes in the working tree." ;;
    git_discard_paths) WARN="Destructive: discards uncommitted changes in the working tree (checkout -- paths, checkout -f, switch -f or restore)." ;;
    git_clean) WARN="Destructive: git clean -f permanently deletes untracked files, which git cannot bring back." ;;
    git_stash_drop) WARN="Destructive: git stash drop/clear deletes stashed work." ;;
    git_worktree_force) WARN="Destructive: git worktree remove --force deletes a worktree and its uncommitted changes." ;;
  esac
  return 0
}
_careful_pending() {
  local q=0 d
  local IFS=' '
  set -f
  while [ "$q" -lt "$_PEND_N" ]; do
    d="${_PEND_DIR[$q]}"
    if [ -z "$d" ] || _careful_tree_dirty "${_PEND_KIND[$q]}" "$d" ${_PEND_ARGS[$q]}; then
      _careful_git_warn "${_PEND_NAME[$q]}"
      break
    fi
    q=$((q + 1))
  done
  set +f
  return 0
}

_careful_find_tmpvars
_careful_scan

# --- HIGH tier: hard deny (best-effort advisory hard-stop, NOT a policy boundary) ---
# In any command shape: a recursive delete of /, the home folder, a top-level
# system folder or a personal data folder; a forced push (not
# --force-with-lease) to main, master or the default branch; a raw write,
# format or wipe of a whole disk. curl|sh stays allowed: hard-denying it would
# block legitimate installer flows, including gstack's own setup pattern.
_careful_deny() {
  _careful_log_fire "$1"
  gstack_hook_decision deny "[careful][HIGH] $2"
  exit 0
}
_RX_DISK="(^|[[:space:];&|(])dd[[:space:]]+(${_NS}[[:space:]])?of=/dev/(sd|nvme|disk|rdisk|hd|vd|xvd|mmcblk)|(^|[[:space:];&|(])mkfs(\.[[:alnum:]_]+)?[[:space:]]+${_NS}/dev/(sd|nvme|disk|hd|vd|xvd|mmcblk)|>[[:space:]]*/dev/(sd|nvme|disk|hd|vd|xvd)[a-z0-9]*|diskutil[[:space:]]+(erase|zeroDisk|secureErase)"
if [ "$_HI_RM_ROOT" -eq 1 ]; then
  _careful_deny high_rm_root "Recursive delete of /, the home directory, or a top-level system or personal folder is blocked by gstack's destructive-command check. If the user truly means it, they run it themselves."
fi
if [ -n "$_PUSH_DENY" ]; then
  _careful_deny high_force_push_default "Force-push to the default branch ($_PUSH_DENY) is blocked by gstack's destructive-command check. Use --force-with-lease on a feature branch; if the user truly means it, they run it themselves."
fi
# wipefs with -a in any spelling (-a, a short group holding a, --a, --al,
# --all), however its targets arrive: on the line, from xargs or from stdin.
# The one exemption: every statement in the command is a wipefs invocation
# the statement scan proved, and the command holds no other wipefs word.
_RX_WIPEFS="(^|[[:space:];&|(/'\"${_BT}])wipefs['\"]?([[:space:]]${_NS})?(-a|[[:space:]'\"]-[[:alnum:]]*a)"
_WIPEFS_HI=0
case "$CMD_MEDIUM" in
  *wipefs*)
    if [[ $CMD_MEDIUM =~ $_RX_WIPEFS ]]; then
      _WIPEFS_HI=1
      _W_REST="${CMD_MEDIUM//wipefs/}"
      if [ "$_WIPEFS_SAFE" -gt 0 ] && [ "$_WIPEFS_SAFE" -eq "$_WIPEFS_SEEN" ] && [ "$_WIPEFS_SAFE" -eq "$_STMT_N" ] && [ $(( (${#CMD_MEDIUM} - ${#_W_REST}) / 6 )) -eq "$_WIPEFS_SEEN" ]; then _WIPEFS_HI=0; fi
    fi ;;
esac
if [ "$_HI_DISK" -eq 1 ] || [ "$_WIPEFS_HI" -eq 1 ] || [[ $CMD_MEDIUM =~ $_RX_DISK ]]; then
  _careful_deny high_disk "Writing to, formatting or wiping a whole disk is blocked by gstack's destructive-command check. If the user truly means it, they run it themselves."
fi

# --- Check for safe exceptions (one standalone rm of build artifacts) ---
# Match the complete command. Parsing only the last rm is unsafe because shell
# syntax or comments can hide an earlier destructive command, for example:
#   rm -rf / # rm -rf node_modules
# Unknown syntax fails closed and falls through to the destructive checks.
# Two hardenings on top of the anchored shape (#2039 wave):
#   - flag cluster accepts capital -R (BSD/macOS recursive), so a single
#     `rm -Rf node_modules` stays allowed instead of prompting;
#   - target tokens exclude `(` and backtick, so command substitution that
#     ENDS in a whitelisted suffix (`rm -rf $(./wipe-all)/node_modules`)
#     cannot ride the whitelist. Plain $VAR expansion (no parenthesis) is
#     still allowed.
#   - multi-line commands never ride the whitelist: grep matches the anchored
#     shape against EACH line, so `rm -rf /\nrm -rf node_modules` would be
#     allowed by its second line. With the JSON-parser extraction the \n in
#     the payload is a real newline (the old grep extractor kept it as two
#     literal characters, which broke the anchored match by accident).
case "$CMD" in
  *$'\n'*) : ;; # multi-line: fall through to the destructive checks
  *..*) : ;; # a path climbing out with .. is never build output here
  *rm*)
    if grep -qE '^[[:space:]]*rm[[:space:]]+(-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+|--recursive[[:space:]]+)(([^[:space:];&|#(`]*/)?(node_modules|\.next|dist|__pycache__|\.cache|build|\.turbo|coverage)[[:space:]]*)+$' <<< "$CMD" 2>/dev/null; then
      echo '{}'
      exit 0
    fi
    ;;
esac

# --- PowerShell and cmd table (#3067) ---
# Runs on the PowerShell tool's command, and on the part of any command from a
# nested `powershell`/`pwsh`/`cmd` launcher onward (`pwsh -c "..."`,
# `cmd /c rd /s /q x`, Git Bash's `cmd //c`). Plain Bash commands never reach
# it, so Bash keeps exactly its old behavior. Best-effort: PowerShell can
# build commands at runtime, so encoded and dynamic forms ask instead of being
# parsed, and Claude Code permission deny rules stay the stronger layer.
# Matching is bash [[ =~ ]] on the already-lowercased command (POSIX ERE,
# bash 3.2 compatible): no added subprocess on the per-command path.
_WIN_SCAN=""
[ "$TOOL_NAME" = "PowerShell" ] && _WIN_SCAN="$CMD_LOWER"
_WIN_LAUNCH_RE='(^|[^a-z0-9_.$-])((powershell|pwsh|cmd)(\.exe)?([[:space:]].*)?)$'
if [ -z "$_WIN_SCAN" ] && [[ $CMD_LOWER =~ $_WIN_LAUNCH_RE ]]; then
  _WIN_SCAN="${BASH_REMATCH[2]}"
fi
if [ -n "$_WIN_SCAN" ]; then
  # cmd escapes with ^ (r^d is rd) and PowerShell with a backtick
  # (Re`move-Item is Remove-Item); dropping both only joins characters.
  _WIN_SCAN="${_WIN_SCAN//^/}"
  _WIN_SCAN="${_WIN_SCAN//\`/}"
  _NL=$'\n'
  # Command position: start of text, a statement/pipeline separator, an
  # opening bracket or quote, or right after a shell launcher and its
  # switches. Names elsewhere (ord, --del, /rd/, git branch -d) never match.
  _CP="(^|[;&|({}\"'${_NL}]|(powershell|pwsh|cmd)(\.exe)?([[:space:]]+(-|/+)[a-z]+([[:space:]:=]+[a-z0-9_.-]+)?)*)[[:space:]]*"
  _STMT="[^;|${_NL}]*"
  _CMD_STMT="[^;|&${_NL}]*"
  _WHY_DYNAMIC="Encoded or dynamic PowerShell can't be inspected, so /careful cannot tell what it will run. Read it before approving; Claude Code permission deny rules (for example \"PowerShell(Remove-Item *)\") are the stronger layer."
  # One table: pattern name, ERE, warning. Parameters match any unique
  # prefix PowerShell accepts (-r/-rec/-recurse, -fo/-forc/-force; -f alone
  # is ambiguous with -Filter), with or without a :$true value.
  _WIN_RULES=(
    ps_remove_item
    "${_CP}(remove-item|rm|ri|del|erase|rd|rmdir)[[:space:]](${_STMT}[[:space:]])?-(r|re|rec|recu|recur|recurs|recurse|fo|for|forc|force)([[:space:]:]|$)"
    "Destructive: PowerShell Remove-Item (or rm/ri/del/erase/rd/rmdir) with -Recurse or -Force. This permanently removes files."
    cmd_rd_s
    "${_CP}(rd|rmdir)[[:space:]]${_CMD_STMT}/s([[:space:]/]|$)"
    "Destructive: cmd rd/rmdir /s deletes a whole directory tree."
    cmd_del_s
    "${_CP}(del|erase)[[:space:]]${_CMD_STMT}/s([[:space:]/]|$)"
    "Destructive: cmd del/erase /s deletes matching files in every subdirectory."
    ps_format_volume
    "${_CP}format-volume([[:space:]]|$)"
    "Destructive: Format-Volume erases a whole volume."
    ps_clear_disk
    "${_CP}clear-disk([[:space:]]|$)"
    "Destructive: Clear-Disk wipes every partition on a disk."
    ps_clear_content
    "${_CP}(clear-content|clc)([[:space:]]|$)"
    "Destructive: Clear-Content empties files (like truncate)."
    ps_dotnet_delete
    '\[(system\.)?io\.(directory|file)\]::delete'
    "Destructive: .NET [IO.Directory]::Delete / [IO.File]::Delete removes files without Remove-Item."
    ps_encoded_command
    "(^|[^a-z0-9_.$-])(powershell|pwsh)(\.exe)?[[:space:]](${_STMT}[[:space:]])?-(e|ec|en|enc[a-z]*)([[:space:]:]|$)"
    "PowerShell -EncodedCommand. ${_WHY_DYNAMIC}"
    ps_invoke_expression
    "${_CP}(invoke-expression|iex)([[:space:](]|$)"
    "PowerShell Invoke-Expression (iex). ${_WHY_DYNAMIC}"
    ps_start_process_shell
    "${_CP}(start-process|saps|start)[[:space:]](${_STMT}[[:space:]\"',])?(powershell|pwsh|cmd|bash|wsl|sh)(\.exe)?([[:space:]\"',]|$)"
    "Start-Process launching another shell. ${_WHY_DYNAMIC}"
    ps_call_operator
    "(^|[^&])&[[:space:]]*[\$(]"
    "PowerShell call operator on a variable or expression (& \$cmd). ${_WHY_DYNAMIC}"
  )
  _WI=0
  while [ "$_WI" -lt "${#_WIN_RULES[@]}" ]; do
    _WRE="${_WIN_RULES[$((_WI + 1))]}"
    if [[ $_WIN_SCAN =~ $_WRE ]]; then
      PATTERN="${_WIN_RULES[$_WI]}"
      WARN="${_WIN_RULES[$((_WI + 2))]} (pattern: $PATTERN)"
      break
    fi
    _WI=$((_WI + 3))
  done
fi

# rm -rf / rm -r / rm -R / rm --recursive with a target that is not scratch
# (GEVA-560: /tmp, mktemp, caches and build artifacts no longer ask).
if [ -z "$WARN" ] && [ "$_RM_UNSAFE" -eq 1 ]; then
  WARN="Destructive: recursive delete (rm -r). This permanently removes files."
  PATTERN="rm_recursive"
fi

# SQL DROP and TRUNCATE ask only when the command runs a SQL client or a
# database call; the words in a grep pattern, a comment or a test file don't.
_RX_SQL_CLIENT="(^|[[:space:];&|(\"'/])(psql|mysql|mysqlsh|mariadb|sqlite3|pgcli|usql|wrangler[[:space:]]+d1[[:space:]]+execute|turso[[:space:]]+db[[:space:]]+shell|invoke-sqlcmd|clickhouse(-client)?|duckdb|sqlcmd|snowsql|bq[[:space:]]+query|cockroach[[:space:]]+sql|mongosh|cqlsh|supabase[[:space:]]+db|prisma[[:space:]]+db[[:space:]]+execute|rails[[:space:]]+(db|dbconsole)|manage\.py[[:space:]]+dbshell)([^[:alnum:]_/]|\$)|\.(execute(script|many)?|query|exec|raw)[[:space:]]*[(]|executeraw|\.sql[[:space:]]*[(]|(^|[^[:alnum:]_])(sqlalchemy|pymysql)([^[:alnum:]_]|\$)|(^|[^[:alnum:]_])psycopg|(^|[^[:alnum:]_])sqlite3\.connect"
_RX_DROP='drop[[:space:]]+(table|database)'
if [ -z "$WARN" ] && [[ $CMD_MEDIUM_LOWER =~ $_RX_DROP ]] && [[ $CMD_MEDIUM_LOWER =~ $_RX_SQL_CLIENT ]]; then
  WARN="Destructive: SQL DROP detected. This permanently deletes database objects."
  PATTERN="drop_table"
fi

# TRUNCATE TABLE, TRUNCATE x; / CASCADE / RESTART, or TRUNCATE x run by a SQL client.
_RX_TRUNC="(^|[^[:alnum:]_])truncate[[:space:]]+table([^[:alnum:]_]|\$)|(^|[^[:alnum:]_])truncate[[:space:]]+[[:alnum:]_.\"${_BT}]+[[:space:]]*(;|cascade([^[:alnum:]_]|\$)|restart([^[:alnum:]_]|\$))"
_RX_TRUNC_ANY="(^|[^[:alnum:]_])truncate[[:space:]]+[[:alnum:]_.\"${_BT}]"
# The SQL shape alone does not count inside a search (grep, rg, git grep) or
# text printed with echo or printf that is not piped on to another command.
_careful_stmt_at() {
  local pre="${2%%"$1"*}" post="${2#*"$1"}" tail
  _S="${pre##*[;&|$_NL]}"
  tail="${post%%[;&|$_NL]*}"
  _R="${post:${#tail}:2}"
  _D="$post"
  _TL="$tail"
}
_careful_text_only() {
  local w sep="$2"
  set -f
  set -- $1
  set +f
  while [ $# -gt 0 ]; do case "$1" in sudo|env|command|*=*|'('|'{') shift ;; *) break ;; esac; done
  w="${1:-}"; w="${w#(}"
  case "$w" in
    grep|egrep|fgrep|zgrep|rg|ag|ack) return 0 ;;
    git) [ "${2:-}" = grep ] && return 0 ;;
    echo|printf)
      # Printed text that goes on to a pipe or a file may be run later.
      sep="${_D//||/}"
      case "$_S$_TL$sep" in *'|'*|*'>'*) ;; *) return 0 ;; esac ;;
  esac
  return 1
}
if [ -z "$WARN" ] && case "$CMD_MEDIUM_LOWER" in *truncate*) true ;; *) false ;; esac; then
  _hit=0
  if [[ $CMD_MEDIUM_LOWER =~ $_RX_TRUNC_ANY ]] && [[ $CMD_MEDIUM_LOWER =~ $_RX_SQL_CLIENT ]]; then _hit=1; fi
  _rest="$CMD_MEDIUM_LOWER"
  while [ "$_hit" -eq 0 ] && [[ $_rest =~ $_RX_TRUNC ]]; do
    _careful_stmt_at "${BASH_REMATCH[0]}" "$_rest"
    _careful_text_only "$_S" "$_R" || _hit=1
    _rest="$_D"
  done
  if [ "$_hit" -eq 1 ]; then
    WARN="Destructive: SQL TRUNCATE detected. This deletes all rows from a table."
    PATTERN="truncate"
  fi
fi

# git push --force / -f / +refspec / --force-with-lease, read from the push's
# own arguments (a tail -f elsewhere on the line is not a force); --dry-run
# never asks. Deleting a remote branch or tag asks too.
if [ -z "$WARN" ] && [ "$_PUSH_FORCE" -eq 1 ]; then
  WARN="Destructive: git force-push rewrites remote history. Other contributors may lose work."
  PATTERN="git_force_push"
fi
if [ -z "$WARN" ] && [ "$_PUSH_DELETE" -eq 1 ]; then
  WARN="Destructive: git push --delete removes a branch or tag on the remote."
  PATTERN="git_push_delete"
fi

# Commands that throw away uncommitted work. reset --hard, checkout -- paths,
# checkout -f, switch -f/--discard-changes, restore without --staged and
# clean -f ask only when the tree really holds work they would discard; stash
# drop/clear and worktree remove --force always ask.
if [ -z "$WARN" ] && [ -n "$_LOSE_NOW" ]; then _careful_git_warn "$_LOSE_NOW"; fi
if [ -z "$WARN" ] && [ "$_PEND_N" -gt 0 ]; then _careful_pending; fi

# kubectl delete
if [ -z "$WARN" ] && grep -qE 'kubectl\s+delete' <<< "$CMD_MEDIUM" 2>/dev/null; then
  WARN="Destructive: kubectl delete removes Kubernetes resources. May impact production."
  PATTERN="kubectl_delete"
fi

# docker rm -f / docker system prune
if [ -z "$WARN" ] && grep -qE 'docker\s+(rm\s+-f|system\s+prune)' <<< "$CMD_MEDIUM" 2>/dev/null; then
  WARN="Destructive: Docker force-remove or prune. May delete running containers or cached images."
  PATTERN="docker_destructive"
fi

# History rewrites that remove the way back.
_RX_BFG='(^|[[:space:];&|(])(bfg|java[[:space:]]+-jar[[:space:]]+[^[:space:]]*bfg[^[:space:]]*\.jar)[[:space:]]'
if [ -z "$WARN" ] && { [ "$_HIST" -eq 1 ] || [[ $CMD_MEDIUM =~ $_RX_BFG ]]; }; then
  WARN="Destructive: rewrites git history or expires the reflog, which removes the way back."
  PATTERN="git_history"
fi

# Databases, cloud and cluster resources.
_RX_DB="prisma[[:space:]]+migrate[[:space:]]+reset|prisma[[:space:]]+db[[:space:]]+push[[:space:]]+${_NS}--(force-reset|accept-data-loss)|alembic[[:space:]]+downgrade[[:space:]]+(base|-[0-9])|supabase[[:space:]]+db[[:space:]]+reset|(rails|rake)[[:space:]]+db:(drop|reset|purge|schema:load)|manage\.py[[:space:]]+flush|(^|[[:space:];&|(])dropdb[[:space:]]|redis-cli([[:space:]]${_NS})?[^[:alnum:]_]flush(all|db)([^[:alnum:]_]|\$)|(^|[^[:alnum:]_])dropdatabase[[:space:]]*[(]|(^|[^[:alnum:]_])drop[[:space:]]+schema([^[:alnum:]_]|\$)|(^|[^[:alnum:]_])delete[[:space:]]+from[[:space:]]+[[:alnum:]_.\"${_BT}]+[[:space:]]*(;|\"|'|\$)"
if [ -z "$WARN" ] && [[ $CMD_MEDIUM_LOWER =~ $_RX_DB ]]; then
  WARN="Destructive: resets, drops or empties a database."
  PATTERN="db_destructive"
fi
_RX_CLOUD="terraform[[:space:]]+(destroy|apply[[:space:]]+${_NS}-destroy)|pulumi[[:space:]]+destroy|(^|[[:space:];&|(])aws[[:space:]]+${_NS}(s3[[:space:]]+(rm[[:space:]]+${_NS}--recursive|rb)|s3[[:space:]]+sync[[:space:]]+${_NS}--delete|[a-z0-9-]*[[:space:]]+(delete|terminate|remove|deregister)-[a-z0-9-]+)|(gcloud|az|doctl)[[:space:]]+${_NS}[[:space:]](delete|destroy)([^[:alnum:]_]|\$)|(flyctl|fly)[[:space:]]+${_NS}(destroy|apps[[:space:]]+destroy)([^[:alnum:]_]|\$)|heroku[[:space:]]+(apps:destroy|pg:reset)|helm[[:space:]]+(uninstall|delete)[[:space:]]|gh[[:space:]]+(repo|release)[[:space:]]+delete([^[:alnum:]_]|\$)|docker[[:space:]]+volume[[:space:]]+(rm|prune)([^[:alnum:]_]|\$)|docker[[:space:]]+system[[:space:]]+prune[[:space:]]+${_NS}--volumes"
# A dry run counts only inside the same statement as the delete.
_RX_CLOUD_DRY='--dryrun|--dry-run|(^|[[:space:]])plan([[:space:]]|$)'
_rest="$CMD_MEDIUM"
while [ -z "$WARN" ] && [[ $_rest =~ $_RX_CLOUD ]]; do
  _m="${BASH_REMATCH[0]}"
  _careful_stmt_at "$_m" "$_rest"
  _tail="${_D%%[;&|$_NL]*}"
  _stmt="$_m$_tail"
  if ! [[ $_stmt =~ $_RX_CLOUD_DRY ]]; then
    WARN="Destructive: deletes cloud or cluster resources (terraform/pulumi destroy, aws/gcloud/az delete, helm uninstall, docker volume rm)."
    PATTERN="cloud_destructive"
  fi
  _rest="$_D"
done

# Deletes outside this session's folder (rm with any flags, find -delete,
# find -exec rm, rsync --delete, shred, unlink), or through a variable that
# may be unset.
if [ -z "$WARN" ] && [ "$_OUTSIDE" -eq 1 ]; then
  WARN="Destructive: deletes files outside this session's folder, or through a variable that may be empty."
  PATTERN="delete_outside"
fi

# --- Additive project patterns ---
# Config can only ADD warn rules, never remove or weaken a baseline family:
# these files are consulted AFTER the hardcoded checks and only when none of
# them matched, so no file content can suppress a baseline warning. One POSIX
# ERE per line; blank lines and #-comments skipped; an invalid regex is
# skipped (never fatal — the hook must not break on a typo in config).
if [ -z "$WARN" ]; then
  # Same state root the writer (/careful via gstack-paths) uses — see
  # gstack_hook_state_root in hook-extract.sh (#1459 class).
  if command -v gstack_hook_state_root >/dev/null 2>&1; then
    _GSTACK_HOME_DIR="$(gstack_hook_state_root; printf x)"; _GSTACK_HOME_DIR="${_GSTACK_HOME_DIR%x}"
  else
    # Older hook-extract.sh (partial upgrade): the plain chain beats dying
    # under set -e with no decision JSON — rules under $HOME/.gstack still load.
    _GSTACK_HOME_DIR="${GSTACK_HOME:-$HOME/.gstack}"
  fi
  _PATTERN_FILES="$_GSTACK_HOME_DIR/careful-patterns.txt"
  # Short-circuit: resolving the project slug costs a subprocess + git call on
  # EVERY Bash command while /careful is active — only pay it when some
  # per-project pattern file actually exists anywhere.
  _ANY_PROJ_PAT=$(find "$_GSTACK_HOME_DIR/projects" -maxdepth 2 -name careful-patterns.txt -print -quit 2>/dev/null || true)
  if [ -n "$_ANY_PROJ_PAT" ]; then
    eval "$("$_HOOK_DIR/../../bin/gstack-slug" 2>/dev/null)" 2>/dev/null || true
    if [ -n "${SLUG:-}" ]; then
      _PATTERN_FILES="$_PATTERN_FILES
$_GSTACK_HOME_DIR/projects/$SLUG/careful-patterns.txt"
    fi
  fi
  while IFS= read -r _PF; do
    [ -f "$_PF" ] || continue
    while IFS= read -r _PAT || [ -n "$_PAT" ]; do
      case "$_PAT" in ''|'#'*) continue ;; esac
      _PAT_RC=0
      printf '' | grep -qE -- "$_PAT" 2>/dev/null || _PAT_RC=$?
      [ "$_PAT_RC" -eq 2 ] && continue # invalid ERE — skip the line
      if grep -qE -- "$_PAT" <<< "$CMD_MEDIUM" 2>/dev/null; then
        WARN="Project rule matched: $_PAT"
        PATTERN="project_rule"
        break
      fi
    done < "$_PF"
    [ -n "$WARN" ] && break
  done <<EOF_PATTERN_FILES
$_PATTERN_FILES
EOF_PATTERN_FILES
fi

# --- Output ---
if [ -n "$WARN" ]; then
  _careful_log_fire "$PATTERN"
  gstack_hook_decision ask "[careful] $WARN"
else
  echo '{}'
fi
