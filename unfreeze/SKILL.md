---
name: unfreeze
version: 0.1.0
description: Clear the freeze boundary set by /freeze, allowing edits to all directories again. (gstack)
triggers:
  - unfreeze edits
  - unlock all directories
  - remove edit restrictions
allowed-tools:
  - Bash
  - Read
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## When to invoke this skill

Use when you want to widen edit scope without ending the session.
Use when asked to "unfreeze", "unlock edits", "remove freeze", or
"allow all edits".

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


# /unfreeze — Clear Freeze Boundary

Remove the edit restriction set by `/freeze`, allowing edits to all directories.

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"unfreeze","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## Clear the boundary

```bash
_GSTACK_BOOT="${GSTACK_ROOT:-}"; [ -x "$_GSTACK_BOOT/bin/gstack-runtime-env" ] || _GSTACK_BOOT="${CLAUDE_PLUGIN_ROOT:-}"; [ -x "$_GSTACK_BOOT/bin/gstack-runtime-env" ] || _GSTACK_BOOT=$(cat "$HOME/.claude/skills/.gstack-root" 2>/dev/null || true); [ -x "$_GSTACK_BOOT/bin/gstack-runtime-env" ] || _GSTACK_BOOT="$HOME/.claude/skills/gstack"
eval "$(GSTACK_RUNTIME_ROOT_OVERRIDE="$_GSTACK_BOOT" "$_GSTACK_BOOT/bin/gstack-runtime-env")"
eval "$("$GSTACK_ROOT"/bin/gstack-paths)"
STATE_DIR="$GSTACK_STATE_ROOT"
if [ -f "$STATE_DIR/freeze-dir.txt" ]; then
  PREV=$(cat "$STATE_DIR/freeze-dir.txt")
  rm -f "$STATE_DIR/freeze-dir.txt"
  echo "Freeze boundary cleared (was: $PREV). Edits are now allowed everywhere."
else
  echo "No freeze boundary was set."
fi
```

Tell the user the result. Note that `/freeze` hooks are still registered for the
session — they will just allow everything since no state file exists. To re-freeze,
run `/freeze` again.
