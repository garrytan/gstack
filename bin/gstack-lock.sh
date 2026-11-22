# shellcheck shell=bash
# gstack-lock.sh — the one way gstack shell code takes a lock directory.
#
# Source it, then call:
#
#   gstack_lock_take DIR [FILE] [CONTENT]
#     Take the lock DIR by creating DIR/FILE (default `pid`) holding CONTENT
#     (default $$). Returns 0 when this shell took the lock, 1 when it is held
#     (DIR already existed, or another process created FILE first), 2 when DIR
#     could not be created (missing or unwritable parent, read-only filesystem)
#     and 3 when DIR was made but FILE could not be created or fully written
#     in it (disk full, quota, a file-size limit; FILE and DIR are removed
#     again, so a failed write never leaves a lock nobody holds). Neither 2
#     nor 3 is evidence of a competing holder.
#
# Why not `mkdir DIR && ...`: mkdir's exit status is not a lock. Rust
# coreutils (uutils) 0.8.0, the mkdir on Ubuntu 26.04 and on GitHub's
# ubuntu-latest from 2026-11-09, reports success when another process created
# the directory first, so two racing callers could both think they held it.
# Here mkdir only makes the directory and its status is ignored. The arbiter is
# the shell's noclobber redirect, which bash, zsh and dash open with
# O_CREAT|O_EXCL themselves (no external binary), so the kernel lets exactly one
# caller create FILE. flock(1) is not used: stock macOS does not ship it.
#
# A DIR that exists before the call is never taken, even with no FILE in it, so
# a lock left by a holder killed between mkdir and FILE stays held until the
# caller's own stale-lock recovery removes it, exactly as before. Callers keep
# their own waiting, staleness, takeover and release logic; the owner still
# releases with `rm -rf DIR`. Safe under set -e and set -u, and noclobber never
# leaks into the caller's shell.
gstack_lock_take() {
  local _gl_dir="$1" _gl_file="${2:-pid}" _gl_content="${3:-$$}"
  if [ -e "$_gl_dir" ] || [ -L "$_gl_dir" ]; then return 1; fi
  mkdir "$_gl_dir" 2>/dev/null || :
  if [ ! -d "$_gl_dir" ] || [ -L "$_gl_dir" ]; then
    if [ -e "$_gl_dir" ] || [ -L "$_gl_dir" ]; then return 1; fi
    return 2
  fi
  local _gl_opened
  _gl_opened=$(set -o noclobber; { echo o; printf '%s\n' "$_gl_content" >&3; } 2>/dev/null 3> "$_gl_dir/$_gl_file") && return 0
  if [ "$_gl_opened" = o ]; then
    rm -f "$_gl_dir/$_gl_file"; rmdir "$_gl_dir" 2>/dev/null || :
    return 3
  fi
  if [ -e "$_gl_dir/$_gl_file" ] || [ -L "$_gl_dir/$_gl_file" ] || [ ! -d "$_gl_dir" ]; then return 1; fi
  rmdir "$_gl_dir" 2>/dev/null || :
  return 3
}
