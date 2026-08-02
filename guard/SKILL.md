---
name: guard
version: 0.1.0
description: "Full safety mode: destructive command warnings + directory-scoped edits. (gstack)"
triggers:
  - full safety mode
  - guard against mistakes
  - maximum safety
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash $HOME/.claude/skills/gstack/careful/bin/check-careful.sh"
          statusMessage: "Checking for destructive commands..."
    - matcher: "Edit"
      hooks:
        - type: command
          command: "bash $HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"
          statusMessage: "Checking freeze boundary..."
    - matcher: "Write"
      hooks:
        - type: command
          command: "bash $HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"
          statusMessage: "Checking freeze boundary..."
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## When to invoke this skill

Combines /careful (warns before rm -rf, DROP TABLE, force-push, etc.) with
/freeze (blocks edits outside a specified directory). Use for maximum safety
when touching prod or debugging live systems. Use when asked to "guard mode",
"full safety", "lock it down", or "maximum safety".

## Runtime path bootstrap

```bash
_GSTACK_ROOT_MARKER="$HOME/.claude/skills/.gstack-root"
[ -n "${GSTACK_ROOT:-}" ] && [ ! -d "$GSTACK_ROOT/bin" ] && GSTACK_ROOT=""
[ -z "${GSTACK_ROOT:-}" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/VERSION" ] && [ -x "$CLAUDE_PLUGIN_ROOT/bin/gstack-config" ] && GSTACK_ROOT="$CLAUDE_PLUGIN_ROOT"
[ -z "${GSTACK_ROOT:-}" ] && [ -f "$_GSTACK_ROOT_MARKER" ] && GSTACK_ROOT=$(cat "$_GSTACK_ROOT_MARKER" 2>/dev/null || true)
[ -n "${GSTACK_ROOT:-}" ] && [ ! -d "$GSTACK_ROOT/bin" ] && GSTACK_ROOT=""
_GSTACK_DIR=gstack
GSTACK_ROOT="${GSTACK_ROOT:-$HOME/.claude/skills/$_GSTACK_DIR}"
GSTACK_BIN="$GSTACK_ROOT/bin"
GSTACK_BROWSE="$GSTACK_ROOT/browse/dist"
GSTACK_DESIGN="$GSTACK_ROOT/design/dist"
GSTACK_MAKE_PDF="$GSTACK_ROOT/make-pdf/dist"
export GSTACK_ROOT GSTACK_BIN GSTACK_BROWSE GSTACK_DESIGN GSTACK_MAKE_PDF
echo "GSTACK_ROOT: $GSTACK_ROOT"
```

**Portable runtime paths:** Bash blocks run in separate shells, so every later shell block using `$GSTACK_*` includes its own bootstrap. For non-shell tools, replace `$GSTACK_ROOT` with the absolute `GSTACK_ROOT:` value printed above; never pass the variable text literally. For inline shell commands outside fenced blocks, substitute the printed absolute values before execution.


# /guard — Full Safety Mode

Activates both destructive command warnings and directory-scoped edit restrictions.
This is the combination of `/careful` + `/freeze` in a single command.

**Dependency note:** This skill references hook scripts from the sibling `/careful`
and `/freeze` skill directories. Both must be installed (they are installed together
by the gstack setup script).

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"guard","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## Setup

Ask the user which directory to restrict edits to. Use AskUserQuestion:

- Question: "Guard mode: which directory should edits be restricted to? Destructive command warnings are always on. Files outside the chosen path will be blocked from editing."
- Text input (not multiple choice) — the user types a path.

Once the user provides a directory path:

1. Resolve it to an absolute path:
```bash
FREEZE_DIR=$(cd "<user-provided-path>" 2>/dev/null && pwd)
echo "$FREEZE_DIR"
```

2. Ensure trailing slash and save to the freeze state file:
```bash
_GSTACK_BOOT="${GSTACK_ROOT:-}"; [ -x "$_GSTACK_BOOT/bin/gstack-runtime-env" ] || _GSTACK_BOOT="${CLAUDE_PLUGIN_ROOT:-}"; [ -x "$_GSTACK_BOOT/bin/gstack-runtime-env" ] || _GSTACK_BOOT=$(cat "$HOME/.claude/skills/.gstack-root" 2>/dev/null || true); [ -x "$_GSTACK_BOOT/bin/gstack-runtime-env" ] || _GSTACK_BOOT="$HOME/.claude/skills/gstack"
eval "$(GSTACK_RUNTIME_ROOT_OVERRIDE="$_GSTACK_BOOT" "$_GSTACK_BOOT/bin/gstack-runtime-env")"
FREEZE_DIR="${FREEZE_DIR%/}/"
eval "$("$GSTACK_ROOT"/bin/gstack-paths)"
STATE_DIR="$GSTACK_STATE_ROOT"
mkdir -p "$STATE_DIR"
echo "$FREEZE_DIR" > "$STATE_DIR/freeze-dir.txt"
echo "Freeze boundary set: $FREEZE_DIR"
```

Tell the user:
- "**Guard mode active.** Two protections are now running:"
- "1. **Destructive command warnings** — rm -rf, DROP TABLE, force-push, etc. will warn before executing (you can override)"
- "2. **Edit boundary** — file edits restricted to `<path>/`. Edits outside this directory are blocked."
- "To remove the edit boundary, run `/unfreeze`. To deactivate everything, end the session."

## What's protected

See `/careful` for the full list of destructive command patterns and safe exceptions.
See `/freeze` for how edit boundary enforcement works.
