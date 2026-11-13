# gstack-gbrain-home.sh — find the config.json gbrain itself reads.
#
# This file is NOT executable; source it:
#
#   . "$(dirname "$0")/gstack-gbrain-home.sh"
#
# gstack_gbrain_config_path prints the path of gbrain's config.json using
# gbrain's own configDir() rule (src/core/config.ts in garrytan/gbrain):
# GBRAIN_HOME, trimmed of surrounding whitespace, is the PARENT directory and
# ".gbrain" is appended; unset or blank means $HOME/.gbrain. gbrain refuses a
# GBRAIN_HOME that is not absolute or that has a ".." segment, so for one of
# those this prints nothing and returns 1, and the caller must not fall back to
# $HOME/.gbrain (that would be a brain gbrain never reads). gbrainConfigDir() in
# lib/gbrain-exec.ts applies the same parent-directory rule for TypeScript
# callers but does not yet trim or refuse. Every gstack shell read of gbrain's
# config goes through here (#4325).
gstack_gbrain_config_path() {
  local home="${GBRAIN_HOME:-}"
  home="${home#"${home%%[![:space:]]*}"}"
  home="${home%"${home##*[![:space:]]}"}"
  if [ -z "$home" ]; then
    printf '%s\n' "$HOME/.gbrain/config.json"
    return 0
  fi
  case "$home" in
    /*) ;;
    [A-Za-z]:[\\/]*|\\*)
      case "${OSTYPE:-}" in msys*|cygwin*) ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
  case "/$home/" in
    */../*|*\\..\\*|*/..\\*|*\\../*) return 1 ;;
  esac
  printf '%s\n' "${home%/}/.gbrain/config.json"
}
