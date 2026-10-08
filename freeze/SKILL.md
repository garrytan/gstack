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
          command: 'bash -c "exec bash \"$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh\""'
          statusMessage: "Checking freeze boundary..."
    - matcher: "Write"
      hooks:
        - type: command
          command: 'bash -c "exec bash \"$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh\""'
          statusMessage: "Checking freeze boundary..."
    - matcher: "NotebookEdit"
      hooks:
        - type: command
          command: 'bash -c "exec bash \"$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh\""'
          statusMessage: "Checking freeze boundary..."
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->


## When to invoke this skill

Blocks Edit,
Write and NotebookEdit outside the allowed path. Use when debugging to prevent accidentally
"fixing" unrelated code, or when you want to scope changes to one module.
Use when asked to "freeze", "restrict edits", "only edit this folder",
or "lock down edits".

# /freeze — Restrict Edits to a Directory

Lock file edits to a specific directory. Any Edit, Write or NotebookEdit
operation targeting a file outside the allowed path will be **blocked** (not
just warned).

```bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
mkdir -p "$GSTACK_STATE_ROOT"/analytics
echo '{"skill":"freeze","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> "$GSTACK_STATE_ROOT"/analytics/skill-usage.jsonl 2>/dev/null || true
```

## Setup

Ask the user which directory to restrict edits to. Use AskUserQuestion:

- Question: "Which directory should I restrict edits to? Files outside this path will be blocked from editing."
- Text input (not multiple choice) — the user types a path.

Once the user provides a directory path:

Set the user-selected boundary with the shared state writer. It resolves the physical absolute path and serializes replacement with investigation cleanup:
```bash
bash "$HOME/.claude/skills/gstack/freeze/bin/freeze-state.sh" set "<user-provided-path>"
```

Only report success if the helper succeeds. On `FREEZE_BUSY` or unexpected state, preserve it and ask the user to inspect recovery after any active writer finishes; never write or delete the state file directly.

Tell the user: "Edits are now restricted to `<path>/`. Any Edit, Write or
NotebookEdit outside this directory will be blocked. To change the boundary, run `/freeze`
again. To remove it, run `/unfreeze`."

## How it works

The hook reads `file_path` from the Edit/Write tool input JSON, or
`notebook_path` from a NotebookEdit (Jupyter notebook) call (shared
real-JSON extractor with /careful — one copy, sourced by both hooks), then
checks whether the path starts with the freeze directory. If not, it returns a
`hookSpecificOutput` payload with `permissionDecision: "deny"` to block the
operation (nested under `hookSpecificOutput` — Claude Code ignores a top-level
`permissionDecision`).

Polarity is fail-closed: a tool payload the hook cannot parse is DENIED, not
allowed — a boundary that fails open is not a boundary. A payload that parses
but has neither path field (a non-file tool) is allowed. A deny names the
tool, the path field, the boundary and `/unfreeze`. Symlinks are resolved
through their FINAL component, so an in-boundary symlink pointing outside the
boundary is checked against its target.

The freeze boundary persists until explicitly removed via the state file. The hook
script reads it on every Edit/Write/NotebookEdit invocation. Boundaries containing spaces
are supported.

## Notes

- The trailing `/` on the freeze directory prevents `/src` from matching `/src-old`
- Freeze applies to Edit, Write and NotebookEdit only — Read, Bash, PowerShell, Glob, Grep are unaffected
- This prevents accidental edits, not a security boundary — Bash or PowerShell commands like `sed` or `Set-Content` can still modify files outside the boundary
- To deactivate, run `/unfreeze`; ending or killing a conversation does not remove persisted state
