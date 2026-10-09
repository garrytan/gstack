#!/usr/bin/env bash
# check-careful.sh — PreToolUse hook for /careful skill
# Reads JSON from stdin, checks a Bash or PowerShell command for destructive
# patterns (best-effort string matching, not a security boundary).
# Two tiers:
#   HIGH   — a tiny set of catastrophic SIMPLE commands returns "deny"
#            (best-effort advisory hard-stop, not a policy boundary).
#   MEDIUM — the destructive families below return "ask" (always overridable).
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

# --- HIGH tier: hard deny (best-effort advisory hard-stop, NOT a policy boundary) ---
# Only SIMPLE commands are eligible: string matching cannot resolve what a
# compound command does (`cd X && git push --force` — whose cwd? which repo?),
# so anything containing ; && || | or a newline falls through to the MEDIUM ask
# families below — conservative failure = ask, never guess.
# --force-with-lease is deliberately NOT matched here (it is the safe variant).
# curl|sh stays MEDIUM/allow territory: hard-denying it would block legitimate
# installer flows, including gstack's own setup pattern.
_IS_SIMPLE=1
case "$CMD" in
  *';'*|*'&&'*|*'||'*|*'|'*|*$'\n'*) _IS_SIMPLE=0 ;;
esac
if [ "$_IS_SIMPLE" -eq 1 ]; then
  # Recursive delete aimed at the filesystem root or the whole home directory.
  # Tokenized: options (long or short, any position — --no-preserve-root may
  # trail the target) are skipped; EVERY non-option token must be a root-class
  # target (/, ~, $HOME, /*), and a recursive flag must be present. noglob is
  # forced around word-splitting so a literal /* token never expands.
  if grep -qE '^[[:space:]]*(sudo[[:space:]]+)?rm[[:space:]]' <<< "$CMD" 2>/dev/null \
    && grep -qE '(^|[[:space:]])(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$)' <<< "$CMD" 2>/dev/null; then
    _ROOT_TARGETS=0
    _SAFE_TARGETS=0
    set -f
    for _TOK in $CMD; do
      # Strip one layer of surrounding quotes: rm -rf "/" is still rm -rf /.
      _TOK="${_TOK#\"}"; _TOK="${_TOK%\"}"; _TOK="${_TOK#\'}"; _TOK="${_TOK%\'}"
      case "$_TOK" in
        # Skip non-target decoration: options, `--`, redirections (2>/dev/null
        # is the most common suffix on agent-generated commands), backgrounding.
        sudo|rm|-*|--|[0-9]'>'*|'>'*|'<'*|'&') continue ;;
        '/'|'~'|'~/'|'$HOME'|'$HOME/'|'${HOME}'|'${HOME}/'|'/*'|'//') _ROOT_TARGETS=1 ;;
        *) _SAFE_TARGETS=1 ;;
      esac
    done
    set +f
    if [ "$_ROOT_TARGETS" -eq 1 ] && [ "$_SAFE_TARGETS" -eq 0 ]; then
      _careful_log_fire "high_rm_root"
      gstack_hook_decision deny "[careful][HIGH] Recursive delete of / or the home directory is blocked while /careful is active. If you truly mean it, end the /careful session first."
      exit 0
    fi
  fi
  # Force-push to the repo's default branch (the shared history everyone pulls).
  # Force is carried by -f/--force OR by git's plus-refspec syntax (+main,
  # +HEAD:main) which needs no flag at all. --force-with-lease never matches.
  if grep -qE '^[[:space:]]*git[[:space:]]+push([[:space:]]|$)' <<< "$CMD" 2>/dev/null; then
    _HAS_FORCE=0
    if grep -qE '(^|[[:space:]])(-f|--force)($|[[:space:]])' <<< "$CMD" 2>/dev/null; then
      _HAS_FORCE=1
    elif grep -qE '(^|[[:space:]])\+[^[:space:]]' <<< "$CMD" 2>/dev/null; then
      _HAS_FORCE=1
    fi
    if [ "$_HAS_FORCE" -eq 1 ]; then
      # Full branch path (slashed defaults like release/2.0 stay intact) and
      # FIXED-STRING token comparison — never interpolate a branch name into
      # an ERE (metacharacters would over/under-match).
      _DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||' || true)
      # Conductor worktrees often lack the origin/HEAD symbolic ref — without a
      # fallback the HIGH tier would be silently inert in the primary deploy
      # environment. Probe the two conventional defaults.
      if [ -z "$_DEFAULT_BRANCH" ]; then
        if git show-ref --verify -q refs/remotes/origin/main 2>/dev/null; then
          _DEFAULT_BRANCH="main"
        elif git show-ref --verify -q refs/remotes/origin/master 2>/dev/null; then
          _DEFAULT_BRANCH="master"
        fi
      fi
      if [ -n "$_DEFAULT_BRANCH" ]; then
        _TARGETS_DEFAULT=0
        set -f
        for _TOK in $CMD; do
          # Strip one layer of surrounding quotes: `git push -f origin "main"`
          # must not dodge the deny just because the ref is quoted.
          _TOK="${_TOK#\"}"; _TOK="${_TOK%\"}"; _TOK="${_TOK#\'}"; _TOK="${_TOK%\'}"
          case "$_TOK" in git|push|sudo|-*) continue ;; esac
          _REF="${_TOK#+}"          # +main -> main
          _REF="${_REF##*:}"        # HEAD:main / src:main -> main
          if [ "$_REF" = "$_DEFAULT_BRANCH" ]; then
            _TARGETS_DEFAULT=1
            break
          fi
        done
        set +f
        if [ "$_TARGETS_DEFAULT" -eq 0 ] && grep -qE '^[[:space:]]*git[[:space:]]+push([[:space:]]+(-f|--force))*[[:space:]]*$' <<< "$CMD" 2>/dev/null; then
          # Bare `git push --force` (force flags only, no remote/ref): targets
          # the current branch's upstream — the default branch only when ON it.
          _CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
          [ -n "$_CURRENT_BRANCH" ] && [ "$_CURRENT_BRANCH" = "$_DEFAULT_BRANCH" ] && _TARGETS_DEFAULT=1
        fi
        if [ "$_TARGETS_DEFAULT" -eq 1 ]; then
          _careful_log_fire "high_force_push_default"
          gstack_hook_decision deny "[careful][HIGH] Force-push to the default branch ($_DEFAULT_BRANCH) is blocked while /careful is active. Use --force-with-lease on a feature branch, or end the /careful session if you truly mean it."
          exit 0
        fi
      fi
    fi
  fi
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
  *)
    if grep -qE '^[[:space:]]*rm[[:space:]]+(-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+|--recursive[[:space:]]+)(([^[:space:];&|#(`]*/)?(node_modules|\.next|dist|__pycache__|\.cache|build|\.turbo|coverage)[[:space:]]*)+$' <<< "$CMD" 2>/dev/null; then
      echo '{}'
      exit 0
    fi
    ;;
esac

# --- Destructive pattern checks (MEDIUM tier — always overridable) ---
WARN=""
PATTERN=""

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

# rm -rf / rm -r / rm -R / rm --recursive (capital -R is BSD/macOS recursive)
if [ -z "$WARN" ] && grep -qE 'rm\s+(-[a-zA-Z]*[rR]|--recursive)' <<< "$CMD" 2>/dev/null; then
  WARN="Destructive: recursive delete (rm -r). This permanently removes files."
  PATTERN="rm_recursive"
fi

# DROP TABLE / DROP DATABASE
if [ -z "$WARN" ] && grep -qE 'drop\s+(table|database)' <<< "$CMD_LOWER" 2>/dev/null; then
  WARN="Destructive: SQL DROP detected. This permanently deletes database objects."
  PATTERN="drop_table"
fi

# TRUNCATE
if [ -z "$WARN" ] && grep -qE '\btruncate\b' <<< "$CMD_LOWER" 2>/dev/null; then
  WARN="Destructive: SQL TRUNCATE detected. This deletes all rows from a table."
  PATTERN="truncate"
fi

# git push --force / git push -f / plus-refspec force (git push origin +ref)
if [ -z "$WARN" ] && grep -qE 'git\s+push\s' <<< "$CMD" 2>/dev/null \
  && grep -qE '(-f\b|--force|(^|[[:space:]])\+[^[:space:]])' <<< "$CMD" 2>/dev/null; then
  WARN="Destructive: git force-push rewrites remote history. Other contributors may lose work."
  PATTERN="git_force_push"
fi

# git reset --hard
if [ -z "$WARN" ] && grep -qE 'git\s+reset\s+--hard' <<< "$CMD" 2>/dev/null; then
  WARN="Destructive: git reset --hard discards all uncommitted changes."
  PATTERN="git_reset_hard"
fi

# git checkout . / git restore .
if [ -z "$WARN" ] && grep -qE 'git\s+(checkout|restore)\s+\.' <<< "$CMD" 2>/dev/null; then
  WARN="Destructive: discards all uncommitted changes in the working tree."
  PATTERN="git_discard"
fi

# kubectl delete
if [ -z "$WARN" ] && grep -qE 'kubectl\s+delete' <<< "$CMD" 2>/dev/null; then
  WARN="Destructive: kubectl delete removes Kubernetes resources. May impact production."
  PATTERN="kubectl_delete"
fi

# docker rm -f / docker system prune
if [ -z "$WARN" ] && grep -qE 'docker\s+(rm\s+-f|system\s+prune)' <<< "$CMD" 2>/dev/null; then
  WARN="Destructive: Docker force-remove or prune. May delete running containers or cached images."
  PATTERN="docker_destructive"
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
      if grep -qE -- "$_PAT" <<< "$CMD" 2>/dev/null; then
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
