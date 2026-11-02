# shellcheck shell=bash
# gstack-harness-pid.sh — the harness pid behind a gstack command (sourced,
# never executed). One derivation for every writer that keys per-session
# state on it: bin/gstack-skill-start (the state-root session marker) and
# bin/gstack-lease (the install-scoped workflow lease), so an updater that
# reads leases sees the same pid the session wrote. Bash 3.2 plus ps.
#
# gstack_harness_pid START — walk up from START (the calling shell) past
# shell wrappers and print the first non-shell ancestor. Claude Code runs a
# tool call under a per-call `bash -c`, whose parent is the harness; a host
# that execs the command directly is already the parent. Without a usable ps
# (some Windows shells) START stands. At most 8 hops; pid 0 and 1 stop.
gstack_harness_pid() {
  _hp_pid="$1"
  _hp_hops=0
  while [ "$_hp_hops" -lt 8 ]; do
    _hp_comm=$(ps -o comm= -p "$_hp_pid" 2>/dev/null | head -1) || break
    _hp_comm=${_hp_comm##*/}; _hp_comm=${_hp_comm#-}
    case "$_hp_comm" in bash|sh|zsh|dash|ksh|mksh|ash|fish|busybox) ;; *) break ;; esac
    _hp_up=$(ps -o ppid= -p "$_hp_pid" 2>/dev/null | tr -d ' ')
    case "$_hp_up" in ''|*[!0-9]*|0|1) break ;; esac
    _hp_pid="$_hp_up"
    _hp_hops=$((_hp_hops + 1))
  done
  printf '%s\n' "$_hp_pid"
}

# Harnesses that run every session on a machine under one process: Capy runs
# each tool call as a fresh shell under capy-server, so every session's lease
# names the same pid and a caller's own ancestry includes every sibling's
# holder. Matched on comm, path and a leading - stripped as above.
GSTACK_SHARED_HARNESSES="capy-server"
# gstack_shared_harness PID — true when PID's command is a shared harness.
gstack_shared_harness() {
  _sh_comm=$(ps -o comm= -p "$1" 2>/dev/null | head -1) || return 1
  _sh_comm=${_sh_comm##*/}; _sh_comm=${_sh_comm#-}
  case " $GSTACK_SHARED_HARNESSES " in *" $_sh_comm "*) [ -n "$_sh_comm" ] ;; *) return 1 ;; esac
}
