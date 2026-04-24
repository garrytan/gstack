# gstack-gbrain-lib.sh — shared helpers for setup-gbrain bin scripts.
#
# This file is NOT executable; source it:
#
#   . "$(dirname "$0")/gstack-gbrain-lib.sh"
#
# Provides:
#   read_secret_to_env <VARNAME> <prompt> [--echo-redacted <sed-expr>]
#     — Read a secret from stdin into the named env var without echoing
#     to the terminal. On SIGINT/SIGTERM/EXIT, restores terminal echo so
#     future keystrokes are visible. Optionally emits a redacted preview
#     of what was read so the user can visually confirm they pasted the
#     right thing.
#
#     stdin handling: when stdin is a TTY, stty -echo suppresses echo
#     while the user types. When stdin is piped (automated tests), the
#     stty calls are skipped — piping into `read` is already invisible.
#
#     Var name must match [A-Z_][A-Z0-9_]* to prevent injection via
#     `read -r "$varname"` expansion. Invalid names abort.
#
#     Exported after read so sub-processes inherit the secret. Caller
#     is responsible for `unset <VARNAME>` when done.
#
# Load-bearing for D3-eng (shared secret helper across PAT + URL paste),
# D10 (env-var handoff, never argv), D11 (PAT scope disclosure + SIGINT
# restore), D16 (pooler URL paste hygiene with redacted preview).

# _gstack_gbrain_validate_varname <name> — returns 0 if usable, 2 otherwise.
_gstack_gbrain_validate_varname() {
  local name="$1"
  case "$name" in
    [A-Z_][A-Z0-9_]*) return 0 ;;
    *) return 2 ;;
  esac
}

read_secret_to_env() {
  local varname="" prompt="" redact_expr=""
  # Parse leading positional args (varname, prompt), then optional flags.
  if [ $# -lt 2 ]; then
    echo "read_secret_to_env: usage: read_secret_to_env <VARNAME> <prompt> [--echo-redacted <sed-expr>]" >&2
    return 2
  fi
  varname="$1"; shift
  prompt="$1"; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --echo-redacted) redact_expr="$2"; shift 2 ;;
      *) echo "read_secret_to_env: unknown flag: $1" >&2; return 2 ;;
    esac
  done

  if ! _gstack_gbrain_validate_varname "$varname"; then
    echo "read_secret_to_env: invalid var name '$varname' (must match [A-Z_][A-Z0-9_]*)" >&2
    return 2
  fi

  # stty manipulation only makes sense when stdin is a terminal. In CI /
  # test / piped contexts we skip it — piped input doesn't echo anyway.
  local is_tty=false
  if [ -t 0 ]; then is_tty=true; fi

  if $is_tty; then
    # Save current stty state; restore on any exit path.
    local saved_stty
    saved_stty=$(stty -g 2>/dev/null || echo "")
    # shellcheck disable=SC2064
    trap "stty '$saved_stty' 2>/dev/null; printf '\n' >&2" INT TERM EXIT
    stty -echo 2>/dev/null || true
  fi

  # Prompt on stderr so the caller can capture stdout cleanly.
  printf '%s' "$prompt" >&2

  # Read one line from stdin. `read -r` returns nonzero on EOF-without-
  # newline but still populates `value` with whatever it saw — we want that
  # content, so don't clear on failure.
  local value=""
  IFS= read -r value || true

  if $is_tty; then
    stty "$saved_stty" 2>/dev/null || true
    trap - INT TERM EXIT
    printf '\n' >&2
  fi

  # Assign + export to the named variable.
  printf -v "$varname" '%s' "$value"
  # shellcheck disable=SC2163
  export "$varname"

  # Optional redacted preview after successful read.
  if [ -n "$redact_expr" ] && [ -n "$value" ]; then
    local preview
    preview=$(printf '%s' "$value" | sed "$redact_expr" 2>/dev/null || true)
    if [ -n "$preview" ]; then
      printf 'Got: %s\n' "$preview" >&2
    fi
  fi
}
