---
name: careful
version: 0.2.0
description: "Safety guardrails for destructive commands — a PreToolUse hook prompts for confirmation before rm -rf, DROP TABLE, TRUNCATE, force-push, git reset --hard, git checkout ., kubectl delete and docker prune, and the user can still override each prompt; triggers: be careful / safety mode / prod mode / warn before destructive / guard against rm -rf; the ask must stay nested under hookSpecificOutput and careful/tests/test-check-careful.sh must stay green (gstack)"
triggers:
  - be careful
  - warn before destructive
  - safety mode
  - prod mode
  - guard against rm -rf
allowed-tools:
  - Bash
  - Read
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          # bash -c so bash (not cmd.exe) expands $HOME — see "Hook command form" below
          command: 'bash -c "exec \"$HOME/.claude/skills/gstack/careful/bin/check-careful.sh\""'
          statusMessage: "Checking for destructive commands..."
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->


## When to invoke this skill

Warns before rm -rf, DROP TABLE, force-push, git reset --hard, kubectl
delete, and similar destructive operations. User can override each warning.
Use when touching prod, debugging live systems, or working in a shared
environment. Use when asked to "be careful", "safety mode", "prod mode",
or "careful mode".

# /careful — Destructive Command Guardrails

Safety mode is now **active**. Every bash command will be checked for destructive
patterns before running. If a destructive command is detected, you'll be warned
and can choose to proceed or cancel.

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"careful","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## What's protected

| Pattern | Example | Risk |
|---------|---------|------|
| `rm -rf` / `rm -r` / `rm --recursive` | `rm -rf /var/data` | Recursive delete |
| `DROP TABLE` / `DROP DATABASE` | `DROP TABLE users;` | Data loss |
| `TRUNCATE` | `TRUNCATE orders;` | Data loss |
| `git push --force` / `-f` | `git push -f origin main` | History rewrite |
| `git reset --hard` | `git reset --hard HEAD~3` | Uncommitted work loss |
| `git checkout .` / `git restore .` | `git checkout .` | Uncommitted work loss |
| `kubectl delete` | `kubectl delete pod` | Production impact |
| `docker rm -f` / `docker system prune` | `docker system prune -a` | Container/image loss |

## Safe exceptions

These patterns are allowed without warning:
- `rm -rf node_modules` / `.next` / `dist` / `__pycache__` / `.cache` / `build` / `.turbo` / `coverage`

## How it works

The hook reads the command from the tool input JSON, checks it against the
patterns above, and on a match emits:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[careful] ..."}}
```

The nesting is load-bearing: Claude Code dispatches on
`hookSpecificOutput.permissionDecision`. A bare top-level
`{"permissionDecision":"ask"}` parses fine and is then **ignored** — no prompt
appears and the destructive command runs unchallenged, while the skill looks
armed. Valid decisions are `allow` / `deny` / `ask` / `defer`; `careful` uses
`ask`, so you can always override and proceed.

### Hook command form

`command:` is `bash -c "exec \"$HOME/...\""`, not `bash $HOME/...`. On Windows the
harness spawns hooks through `cmd.exe /d /s /c`, which does not expand `$HOME`;
the bare form passes a literal `$HOME/...` to bash and dies with exit 127 before
any check runs. Wrapping in `bash -c` moves expansion inside bash, where it works
on every platform. `${CLAUDE_SKILL_DIR}` is **not** an option here — the harness
interpolates it only in skill body text, never in hook commands.

## Regression test

`careful/tests/test-check-careful.sh` feeds representative destructive and benign
commands through the script and asserts the warn/allow output schema, the safe
exceptions, and that the `command:` above actually spawns through the harness's
`cmd.exe` wrapper:

```bash
bash ~/.claude/skills/gstack/careful/tests/test-check-careful.sh
```

## Notes

- Warnings are advisory (`ask`), never a hard block — you stay in control
- The warning text never includes your command's contents, only the pattern name
- Detection is regex over the command string, not a shell parser: obfuscated or
  indirect forms (a destructive command inside a script you invoke) are not caught
- To deactivate, end the conversation or start a new one. Hooks are session-scoped
  — unlike `/freeze`, `careful` keeps no state on disk
