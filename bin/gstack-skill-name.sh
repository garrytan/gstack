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

# GSTACK_RENDER_NAMES is written into a render's .overlay record as
# names=<it> (gstack_claude_render_settle). A record without it, or with an
# older value, comes from a gstack whose always-prefixed skills still had
# their plain names (#4775).
GSTACK_RENDER_NAMES=2

# gstack_render_serves RENDER_DIR SKILL returns 0 when RENDER_DIR's copy of
# SKILL may be served instead of the checkout's. An always-prefixed skill
# (GSTACK_PREFIXED_SKILLS, bin/gstack-install-registry.sh) is served from a
# render only when the render's record carries names=$GSTACK_RENDER_NAMES: a
# render made before the skill took its gstack- name, which a failed
# regeneration keeps with its old record, still says to run the plain name the
# host's built-in hides. A per-install render (GSTACK_USER_RENDER_PER_INSTALL=1)
# is always served: it is the only copy that names its install root, and the
# checkout's copy would run the default install. Starts no process, like the
# helper above.
gstack_render_serves() {
  [ -f "$1/$2/SKILL.md" ] || return 1
  [ "${GSTACK_USER_RENDER_PER_INSTALL:-}" != 1 ] || return 0
  case " ${GSTACK_PREFIXED_SKILLS:-} " in *" $2 "*) ;; *) return 0 ;; esac
  [ -f "$1.overlay" ] || return 1
  local _grs_line
  while IFS= read -r _grs_line || [ -n "$_grs_line" ]; do
    [ "${_grs_line//[[:space:]]/}" = "names=$GSTACK_RENDER_NAMES" ] && return 0
  done < "$1.overlay"
  return 1
}
