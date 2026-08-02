---
name: freeze
version: 0.1.0
description: Restrict file edits to a specific directory for the session. (gstack)
triggers:
  - freeze edits to directory
  - lock editing scope
  - restrict file changes
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
hooks:
  PreToolUse:
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

Blocks Edit and
Write outside the allowed path. Use when debugging to prevent accidentally
"fixing" unrelated code, or when you want to scope changes to one module.
Use when asked to "freeze", "restrict edits", "only edit this folder",
or "lock down edits".

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


# /freeze — Restrict Edits to a Directory

Lock file edits to a specific directory. Any Edit or Write operation targeting
a file outside the allowed path will be **blocked** (not just warned).

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"freeze","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## Setup

Ask the user which directory to restrict edits to. Use AskUserQuestion:

- Question: "Which directory should I restrict edits to? Files outside this path will be blocked from editing."
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

Tell the user: "Edits are now restricted to `<path>/`. Any Edit or Write
outside this directory will be blocked. To change the boundary, run `/freeze`
again. To remove it, run `/unfreeze` or end the session."

## How it works

The hook reads `file_path` from the Edit/Write tool input JSON, then checks
whether the path starts with the freeze directory. If not, it returns
`permissionDecision: "deny"` to block the operation.

The freeze boundary persists for the session via the state file. The hook
script reads it on every Edit/Write invocation.

## Notes

- The trailing `/` on the freeze directory prevents `/src` from matching `/src-old`
- Freeze applies to Edit and Write tools only — Read, Bash, Glob, Grep are unaffected
- This prevents accidental edits, not a security boundary — Bash commands like `sed` can still modify files outside the boundary
- To deactivate, run `/unfreeze` or end the conversation
