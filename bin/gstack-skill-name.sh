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
