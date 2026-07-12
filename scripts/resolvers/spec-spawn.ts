import type { TemplateContext } from './types';

/**
 * Host-native agent spawn for /spec --execute (U4 / R3).
 *
 * Grok research matrix (local CLI grok 0.2.x):
 *   -p / --single <PROMPT>   short single-turn
 *   --prompt-file <PATH>     single-turn from file (preferred for archives)
 *   --cwd <CWD>              working directory
 *   --always-approve         elevated auto-approve (opt-in / documented)
 * Never: $(cat …) into argv (ARG_MAX); never invent --permission-mode acceptEdits.
 *
 * Claude host generation unchanged: stdin pipe into claude -p.
 */
export function generateSpecSpawn(ctx: TemplateContext): string {
  if (ctx.host === 'grok-build') {
    return `If A and worktree created: spawn **Grok** headless with the archived
spec as a prompt file (never \`$(cat …)\` into argv — ARG_MAX / quoting risk).

**Auth gate (fail closed):** before spawn, verify Grok is available and configured:

\`\`\`bash
command -v grok >/dev/null 2>&1 || { echo "STOP: grok CLI not on PATH. Install Grok Build, or re-run with --no-execute / --file-only."; exit 1; }
if [ ! -f "$HOME/.grok/auth.json" ] && [ -z "\${XAI_API_KEY:-}\${GROK_API_KEY:-}" ]; then
  echo "STOP: Grok not authenticated (no ~/.grok/auth.json and no XAI_API_KEY/GROK_API_KEY). Log in via \`grok\`, or use --no-execute."
  exit 1
fi
# ARCHIVE_PATH must stay under SPAWN_PATH or the gstack projects allowlist (fail closed).
if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "STOP: ARCHIVE_PATH missing: $ARCHIVE_PATH"; exit 1
fi
if command -v realpath >/dev/null 2>&1; then
  ARCHIVE_REAL=$(realpath "$ARCHIVE_PATH")
else
  ARCHIVE_REAL=$(cd "$(dirname "$ARCHIVE_PATH")" && pwd -P)/$(basename "$ARCHIVE_PATH")
fi
SPAWN_REAL=$(cd "$SPAWN_PATH" 2>/dev/null && pwd -P || echo "")
if [ -z "$SPAWN_REAL" ]; then
  echo "STOP: SPAWN_PATH is not a real directory: $SPAWN_PATH"; exit 1
fi
STATE_PROJECTS="\${GSTACK_STATE_ROOT:-\$HOME/.gstack}/projects"
case "$ARCHIVE_REAL" in
  "$STATE_PROJECTS"/*|"$SPAWN_REAL"/*) ;; # allowlisted
  *)
    echo "STOP: ARCHIVE_PATH realpath not under SPAWN_PATH or allowlisted archive dir ($STATE_PROJECTS)."; exit 1
    ;;
esac
\`\`\`

**Security:** default spawn does **not** pass \`--always-approve\` (elevated
auto-approve). Only spawn after the user confirmed the D16 gate. If the user
explicitly opts into unattended tool use, append \`--always-approve\` to the
command below — never enable it by default. Spec archives must not contain
secrets. Third-party note: archive body is sent to xAI for processing.

\`\`\`bash
# Prefer --prompt-file (researched). Elevated --always-approve is opt-in only.
(cd "$SPAWN_PATH" && grok --prompt-file "$ARCHIVE_PATH" --cwd "$SPAWN_PATH" 2>&1) &
SPAWN_PID=$!
echo "Spawned: PID $SPAWN_PID in $SPAWN_PATH (branch $SPAWN_BRANCH)"
echo "Follow with: cd $SPAWN_PATH && grok --continue"
\`\`\`

**Optional Claude execute:** if the user asked for \`--execute-claude\` instead of
default Grok execute, and \`claude\` is on PATH, you may spawn — only after the
same ARCHIVE_PATH allowlist gate as the Grok path (reuse the block above; never
pipe an unallowlisted archive):

\`\`\`bash
# Re-run allowlist (same fail-closed rules as Grok path) before cat|claude.
if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "STOP: ARCHIVE_PATH missing: $ARCHIVE_PATH"; exit 1
fi
if command -v realpath >/dev/null 2>&1; then
  ARCHIVE_REAL=$(realpath "$ARCHIVE_PATH")
else
  ARCHIVE_REAL=$(cd "$(dirname "$ARCHIVE_PATH")" && pwd -P)/$(basename "$ARCHIVE_PATH")
fi
SPAWN_REAL=$(cd "$SPAWN_PATH" 2>/dev/null && pwd -P || echo "")
if [ -z "$SPAWN_REAL" ]; then
  echo "STOP: SPAWN_PATH is not a real directory: $SPAWN_PATH"; exit 1
fi
STATE_PROJECTS="\${GSTACK_STATE_ROOT:-\$HOME/.gstack}/projects"
case "$ARCHIVE_REAL" in
  "$STATE_PROJECTS"/*|"$SPAWN_REAL"/*) ;; # allowlisted
  *)
    echo "STOP: ARCHIVE_PATH realpath not under SPAWN_PATH or allowlisted archive dir ($STATE_PROJECTS)."; exit 1
    ;;
esac
cat "$ARCHIVE_PATH" | (cd "$SPAWN_PATH" && claude -p 2>&1) &
\`\`\`

Do **not** silently fall through to Claude when Grok is missing — STOP instead.

If no safe multi-line file ingest is available on an older Grok CLI (no
\`--prompt-file\`), demote to \`--no-execute\` / file-only and tell the user:
"This Grok CLI lacks --prompt-file; filed the issue only. Upgrade Grok Build or
use --execute-claude if Claude is installed."`;
  }

  // Claude + all other hosts: classic claude -p stdin pipe
  return `If A and worktree created: spawn \`claude -p\` with the spec piped via stdin:

\`\`\`bash
cat "$ARCHIVE_PATH" | (cd "$SPAWN_PATH" && claude -p 2>&1) &
SPAWN_PID=$!
echo "Spawned: PID $SPAWN_PID in $SPAWN_PATH (branch $SPAWN_BRANCH)"
echo "Follow with: cd $SPAWN_PATH && claude --resume"
\`\`\``;
}

/** Flag-table row for --execute (host-aware description). */
export function generateSpecExecuteFlag(ctx: TemplateContext): string {
  if (ctx.host === 'grok-build') {
    return '| `--execute` | conditional default (see Phase 5) | Spawn `grok --prompt-file` headless in a fresh worktree after filing the issue. |';
  }
  return '| `--execute` | conditional default (see Phase 5) | Spawn `claude -p` in a fresh worktree after filing the issue. |';
}
