# shellcheck shell=bash
# gstack-skill-name.sh: sourced helper (bash 3.2). gstack_skill_md_name FILE
# sets GSTACK_SKILL_NAME to the first column-0 "name:" line of FILE with every
# whitespace character removed (CR included), or to "" when there is none or
# FILE cannot be read. Always returns 0.
#
# It starts no process: no subshell, pipe or command substitution, and callers
# must not wrap it in $( ). Setup reads ~55 names per run, and the
# grep | sed | tr pipeline it replaces deadlocked MSYS2's fork() under x64
# emulation on Windows ARM64 (#2120).
gstack_skill_md_name() {
  GSTACK_SKILL_NAME=
  [ -f "$1" ] && [ -r "$1" ] || return 0
  local _gsn_line
  while IFS= read -r _gsn_line || [ -n "$_gsn_line" ]; do
    case "$_gsn_line" in
      name:*) _gsn_line=${_gsn_line#name:}; GSTACK_SKILL_NAME=${_gsn_line//[[:space:]]/}; return 0 ;;
    esac
  done < "$1"
  return 0
}

# gstack_render_serves RENDER_DIR INSTALL_DIR SKILL returns 0 when RENDER_DIR's
# copy of SKILL may be served instead of the checkout's. An always-prefixed
# skill (GSTACK_PREFIXED_SKILLS, bin/gstack-install-registry.sh) is served from
# a render only when the render's .overlay record names this checkout's
# VERSION: a render made before the skill took its gstack- name, which a failed
# regeneration keeps, still says to run the plain name the host's built-in
# hides (#4775). Starts no process, like the helper above.
gstack_render_serves() {
  [ -f "$1/$3/SKILL.md" ] || return 1
  case " ${GSTACK_PREFIXED_SKILLS:-} " in *" $3 "*) ;; *) return 0 ;; esac
  [ -f "$2/VERSION" ] && [ -f "$1.overlay" ] || return 1
  local _grs_line _grs_have= _grs_want=
  IFS= read -r _grs_want < "$2/VERSION" || [ -n "$_grs_want" ] || return 1
  _grs_want=${_grs_want//[[:space:]]/}
  while IFS= read -r _grs_line || [ -n "$_grs_line" ]; do
    case "$_grs_line" in version=*) _grs_have=${_grs_line#version=}; break ;; esac
  done < "$1.overlay"
  [ -n "$_grs_want" ] && [ "${_grs_have//[[:space:]]/}" = "$_grs_want" ]
}
