---
name: careful
version: 0.1.0
description: "Safety guardrails for destructive commands. Use for: be careful, warn before destructive, safety mode. (gstack)"
triggers:
  - be careful
  - warn before destructive
  - safety mode
allowed-tools:
  - Bash
  - Read
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'bash -c "exec bash \"$HOME/.claude/skills/gstack/careful/bin/check-careful.sh\""'
          statusMessage: "Checking for destructive commands..."
    - matcher: "PowerShell"
      hooks:
        - type: command
          command: 'bash -c "exec bash \"$HOME/.claude/skills/gstack/careful/bin/check-careful.sh\""'
          statusMessage: "Checking for destructive commands..."
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /careful — Destructive Command Guardrails

Safety mode is now **active**. Every Bash and PowerShell command will be checked
for destructive patterns before running. If a destructive command is detected, you'll be warned
and can choose to proceed or cancel.

```bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
mkdir -p "$GSTACK_STATE_ROOT"/analytics
echo '{"skill":"careful","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> "$GSTACK_STATE_ROOT"/analytics/skill-usage.jsonl 2>/dev/null || true
```

## What's protected

Each command in a chain is checked on its own (after `&&`, `sudo`, `xargs`,
inside `bash -c`).

| Asks before | Example |
|-------------|---------|
| `rm -r` of anything but scratch (see below) | `rm -rf /var/data` |
| Deleting outside the session folder: `rm`, find's delete actions, `rsync --delete`, `shred`, `unlink` | `rm -f ~/notes.txt` |
| `DROP TABLE`/`DATABASE` through a SQL client; SQL `TRUNCATE` | `psql -c "DROP TABLE users"` |
| Force-push (`-f`, `+ref`, `--force-with-lease`); remote branch delete | `git push -f origin feature` |
| `reset --hard`, `checkout -f`/`-- paths`, `restore`, `clean -f` when there is work to lose; `stash drop`, `worktree remove --force` | `git clean -fdx` |
| History rewrites (`filter-branch`, BFG, `reflog expire --expire=now`) | |
| Database resets (`prisma migrate reset`, `dropdb`, `FLUSHALL`, `DELETE FROM` with no `WHERE`) | |
| Cloud deletes (`terraform destroy`, `aws`/`gcloud`/`az` delete; not dry runs) | |
| `kubectl delete`, `docker rm -f`, `docker system prune` | |

## PowerShell and cmd (Windows)

The hook also checks the PowerShell tool (Claude Code's main Windows shell)
and any `pwsh`/`powershell`/`cmd` launched from Bash. Matching ignores case,
covers aliases in command position, accepts parameter prefixes (`-r`, `-fo`)
and strips cmd `^` escapes. All rows above apply there too.

| Pattern | Example |
|---------|---------|
| `Remove-Item`/`rm`/`ri`/`del`/`erase`/`rd`/`rmdir` + `-Recurse` or `-Force` | `gci \| ri -r -fo` |
| cmd `rd /s`, `rmdir /s`, `del /s`, `erase /s` | `cmd /c rd /s /q C:\proj` |
| `Format-Volume`, `Clear-Disk`, `Clear-Content`, `[IO.Directory]::Delete`, `[IO.File]::Delete` | `Clear-Disk -Number 1` |
| `-EncodedCommand`, `iex`, `Start-Process` of a shell, `& $cmd` (can't be inspected) | `irm $url \| iex` |

**Best-effort on PowerShell.** String matching can't see a command built at
runtime. For a hard stop, add Claude Code permission deny rules, which parse
PowerShell and its aliases: `"deny": ["PowerShell(Remove-Item *)"]` in
`.claude/settings.json`. The hook runs through `bash`, so Windows needs Git Bash.

## Safe exceptions

A recursive delete never asks when every target is scratch: under `/tmp/` or
`/var/tmp/`, a `$(mktemp)` variable, a relative path after `cd` into scratch, a
cache (`~/.cache`, `~/.npm` and the like), or a build artifact
(`node_modules`, `dist`, `build`, `.next`, `.venv` and the like). A path containing `..` is never scratch.

## How it works

The hook checks each command against the patterns above and returns
`permissionDecision: "ask"` (nested under `hookSpecificOutput`) with a reason.
You can always approve an ask and proceed.

## HIGH tier (hard deny)

**Denied**, not asked: a recursive delete of `/`, `~`, a system folder or
`~/.ssh`-style personal folder; a force-push to `main`, `master` or the
**default branch** (`--force-with-lease` is never HIGH); a disk wipe
(`dd of=/dev/sda`, `mkfs`). Best-effort, not a policy boundary: you can still
run the command yourself.

## Project patterns (additive only)

Add warn rules — one POSIX ERE per line, `#` comments OK — in
`~/.gstack/careful-patterns.txt` (global) or
`~/.gstack/projects/<slug>/careful-patterns.txt` (per-project). Consulted
after the built-in families, so config can only ADD rules, never suppress a
baseline warning. Invalid regex lines are skipped.

## Always on

`./setup` registers this check for every session (`destructive_guard`), so it
runs even when /careful is never loaded; /guard still adds the edit boundary.
Turn it off with `gstack-config set destructive_guard off`; /careful's own
hooks then last until the conversation ends.
