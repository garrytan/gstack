# shellcheck shell=bash
# gstack-bun-version.sh — the one source for the Bun versions gstack needs.
# Sourced, never executed: ./setup refuses or warns from it before writing
# anything, and bin/gstack-session-update and /gstack-upgrade read the
# INCOMING release's floor (gstack_bun_incoming_hold) before advancing a
# live checkout. test/bun-version-drift.test.ts
# keeps it equal to package.json engines.bun, every CI pin, setup's install
# hint and README. Bash 3.2 builtins only.
#
# GSTACK_BUN_FLOOR is the security floor. Older Bun accepts
# --no-compile-autoload-dotenv/--no-compile-autoload-bunfig but ignores them,
# so gstack's compiled tools would read a project's .env. Verified by a
# compiled probe (a binary built with all four no-autoload flags, run beside a
# .env): Bun 1.3.2 loads it, 1.3.3 and 1.4.0 do not.
# GSTACK_BUN_TESTED is the supported minimum: the CI pin and engines.bun.
GSTACK_BUN_FLOOR="1.3.3"
GSTACK_BUN_TESTED="1.4.2"

# gstack_bun_archive_sha256 TARGET — the SHA-256 of
# https://github.com/oven-sh/bun/releases/download/bun-v$GSTACK_BUN_TESTED/bun-TARGET.zip
# from that release's SHASUMS256.txt, for the targets bin/gstack-capy-install
# installs on Capy cloud machines (the same exact-archive recipe as
# .github/docker/Dockerfile.ci; test/bun-version-drift.test.ts keeps them
# equal). Prints nothing and returns 1 for a target without a verified archive.
gstack_bun_archive_sha256() {
  case "$1" in
    linux-x64) echo 36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913 ;;
    linux-x64-baseline) echo c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f ;;
    linux-aarch64) echo 54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
    *) return 1 ;;
  esac
}

# _gstack_bun_parse <version> — sets _gb_core ("MAJOR MINOR PATCH" as decimal
# integers) and _gb_pre (prerelease, may be empty); returns 1 when malformed.
# A leading "v" and "+build" metadata are ignored.
_gstack_bun_parse() {
  _gb_v="${1#v}"; _gb_v="${_gb_v%%+*}"; _gb_pre=""
  case "$_gb_v" in
    *-*) _gb_pre="${_gb_v#*-}"; _gb_v="${_gb_v%%-*}"; [ -n "$_gb_pre" ] || return 1 ;;
  esac
  case "$_gb_v" in *.*.*) ;; *) return 1 ;; esac
  _gb_maj="${_gb_v%%.*}"; _gb_rest="${_gb_v#*.}"; _gb_min="${_gb_rest%%.*}"; _gb_pat="${_gb_rest#*.}"
  case "$_gb_maj" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_min" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_pat" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_pre" in *[!0-9A-Za-z.-]*) return 1 ;; esac
  _gb_core="$((10#$_gb_maj)) $((10#$_gb_min)) $((10#$_gb_pat))"
}

# _gstack_bun_below <version> <release> — true when version sorts below the
# release. Prerelease rule (semver): 1.3.3-canary.1 is below 1.3.3 and above
# 1.3.2, so a prerelease of the floor itself is refused.
_gstack_bun_below() {
  _gstack_bun_parse "$2" || return 1
  set -- "$1" $_gb_core
  _gstack_bun_parse "$1" || return 1
  set -- "$@" $_gb_core
  [ "$5" -ne "$2" ] && { [ "$5" -lt "$2" ]; return; }
  [ "$6" -ne "$3" ] && { [ "$6" -lt "$3" ]; return; }
  [ "$7" -ne "$4" ] && { [ "$7" -lt "$4" ]; return; }
  [ -n "$_gb_pre" ]
}

# gstack_bun_status <version> [floor] — prints too-old, untested, ok or
# malformed. The optional floor lets the auto-updater apply the incoming
# release's floor with this release's comparison rule.
gstack_bun_status() {
  if ! _gstack_bun_parse "$1"; then echo malformed
  elif _gstack_bun_below "$1" "${2:-$GSTACK_BUN_FLOOR}"; then echo too-old
  elif _gstack_bun_below "$1" "$GSTACK_BUN_TESTED"; then echo untested
  else echo ok
  fi
}

# gstack_bun_incoming_hold <git-dir> <rev> — the pre-advance check shared by
# the auto-updater and /gstack-upgrade. Reads the floor from <rev>'s copy of
# this file and checks the `bun` setup will run (first on PATH). Below that
# floor it prints the held reason and returns 0; otherwise it prints nothing
# and returns 1 (no bun, no floor in <rev>, or an unparseable version, which
# setup only warns on). The comparison rule is this release's.
gstack_bun_incoming_hold() {
  command -v bun >/dev/null 2>&1 || return 1
  _gb_floor=$(git -C "$1" show "$2:bin/gstack-bun-version.sh" 2>/dev/null | sed -n 's/^GSTACK_BUN_FLOOR="\([0-9A-Za-z.+-]*\)".*/\1/p' | head -1)
  [ -n "$_gb_floor" ] || return 1
  _gb_found=$(bun --version 2>/dev/null | head -1)
  [ "$(gstack_bun_status "$_gb_found" "$_gb_floor")" = too-old ] || return 1
  _gb_ver=$(git -C "$1" show "$2:VERSION" 2>/dev/null | head -1)
  echo "bun-too-old: found Bun $_gb_found at $(command -v bun); gstack ${_gb_ver:-update} needs $_gb_floor or newer"
}
