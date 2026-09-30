#!/bin/bash
while sleep 5; do
  slow=$(ps -eo pid=,etimes=,comm= | awk '$3 ~ /^git/ && $2 >= 5 {print $1}')
  [ -z "$slow" ] && continue
  echo "=== $(date +%T) slow git: $slow"
  ps -eo pid,ppid,pgid,sid,stat,wchan:32,etimes,args --sort=start_time | grep -vE "ps -eo|sample.sh|sleep 5" | tail -80
  for p in $slow; do
    echo "--- pid $p cwd=$(sudo readlink /proc/$p/cwd) exe=$(sudo readlink /proc/$p/exe)"
    echo "cmdline: $(sudo tr '\0' ' ' < /proc/$p/cmdline)"
    echo "fds: $(sudo ls -l /proc/$p/fd 2>/dev/null | tail -n +2 | awk '{print $9"->"$NF}' | tr '\n' ' ')"
    echo "stack:"; sudo cat /proc/$p/stack 2>/dev/null | head -12
    echo "syscall: $(sudo cat /proc/$p/syscall 2>/dev/null)"
    echo "env GIT/HOME: $(sudo tr '\0' '\n' < /proc/$p/environ | grep -E '^(GIT_|HOME=|XDG_|TMPDIR=|PAGER|EDITOR)' | tr '\n' ' ')"
  done
done
