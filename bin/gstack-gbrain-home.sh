# gstack-gbrain-home.sh — find the config.json gbrain itself reads.
#
# This file is NOT executable; source it:
#
#   . "$(dirname "$0")/gstack-gbrain-home.sh"
#
# gstack_gbrain_config_path prints the path of gbrain's config.json using
# gbrain's own configDir() rule (src/core/config.ts in garrytan/gbrain):
# GBRAIN_HOME, trimmed the way JavaScript trim() trims, is the PARENT directory
# and ".gbrain" is appended; unset or blank means $HOME/.gbrain. gbrain refuses
# a GBRAIN_HOME that is not absolute or that has a ".." segment, so for one of
# those this prints nothing and returns 1, and the caller must not fall back to
# $HOME/.gbrain (that would be a brain gbrain never reads). gbrainConfigDir() in
# lib/gbrain-exec.ts is the TypeScript twin, and test/gbrain-home-parity.test.ts
# holds both to one table. Every gstack shell read of gbrain's config goes
# through here (#4325).
#
# POSIX [[:space:]] is not trim()'s set: it misses NBSP and the BOM, and in a
# UTF-8 locale it follows the C library. So the set is spelled out as UTF-8
# bytes: ASCII tab through carriage return and space, U+00A0, U+1680,
# U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
gstack_gbrain_config_path() {
  local home="${GBRAIN_HOME:-}" prev ws
  local -a spaces=(' ' $'\t' $'\n' $'\v' $'\f' $'\r' $'\xc2\xa0' $'\xe1\x9a\x80'
    $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' $'\xe2\x80\x83' $'\xe2\x80\x84' $'\xe2\x80\x85'
    $'\xe2\x80\x86' $'\xe2\x80\x87' $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a' $'\xe2\x80\xa8'
    $'\xe2\x80\xa9' $'\xe2\x80\xaf' $'\xe2\x81\x9f' $'\xe3\x80\x80' $'\xef\xbb\xbf')
  while :; do
    prev="$home"
    for ws in "${spaces[@]}"; do
      home="${home#"$ws"}"
      home="${home%"$ws"}"
    done
    [ "$home" = "$prev" ] && break
  done
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
