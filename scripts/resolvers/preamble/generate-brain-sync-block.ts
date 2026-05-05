/**
 * gbrain-sync preamble block.
 *
 * Emits bash that runs at every skill invocation:
 *   0. Live gbrain-availability hint (per /plan-eng-review): when gbrain is
 *      configured, emit one of two variants (steady-state vs empty-corpus
 *      emergency). Zero context cost when gbrain is not configured.
 *   1. If ~/.gstack-brain-remote.txt exists AND ~/.gstack/.git is missing,
 *      surface a restore-available hint (does NOT auto-run restore).
 *   2. If sync is on, run `gstack-brain-sync --once` (drain + push).
 *   3. On first skill of the day (24h cache via .brain-last-pull):
 *      `git fetch` + ff-only merge (JSONL merge driver handles conflicts).
 *   4. Emit a `BRAIN_SYNC:` status line so every skill surfaces health.
 *
 * Also emits prose instructions for the host LLM to fire a one-time privacy
 * stop-gate via AskUserQuestion when gbrain_sync_mode is unset and gbrain
 * is available on the host.
 *
 * Block emitted across all tiers. Internal bash short-circuits when feature
 * is disabled; cost is <5ms.
 *
 * Skill-end sync is handled by the completion-status generator via a call
 * to `gstack-brain-sync --discover-new` + `--once`.
 */
import type { TemplateContext } from '../types';

export function generateBrainSyncBlock(ctx: TemplateContext): string {
  const isBrainHost = ctx.host === 'gbrain' || ctx.host === 'hermes';
  return `## GBrain Sync (skill start)

\`\`\`bash
_GSTACK_HOME="\${GSTACK_HOME:-$HOME/.gstack}"
_BRAIN_REMOTE_FILE="$HOME/.gstack-brain-remote.txt"
_BRAIN_SYNC_BIN="${ctx.paths.binDir}/gstack-brain-sync"
_BRAIN_CONFIG_BIN="${ctx.paths.binDir}/gstack-config"

# /sync-gbrain context-load: teach the agent to use gbrain when it's available.
# Mutually exclusive variants per /plan-eng-review §4. Empty string when gbrain
# is not configured (zero context cost for non-gbrain users).
_GBRAIN_CONFIG="$HOME/.gbrain/config.json"
if [ -f "$_GBRAIN_CONFIG" ] && command -v gbrain >/dev/null 2>&1; then
  _GBRAIN_VERSION_OK=$(gbrain --version 2>/dev/null | grep -c '^gbrain ' || echo 0)
  if [ "$_GBRAIN_VERSION_OK" -gt 0 ] 2>/dev/null; then
    _SYNC_STATE="$_GSTACK_HOME/.gbrain-sync-state.json"
    _CWD_PAGES=0
    if [ -f "$_SYNC_STATE" ]; then
      # Flatten newlines so the regex works against pretty-printed JSON too.
      _CWD_PAGES=$(tr -d '\\n' < "$_SYNC_STATE" 2>/dev/null \\
        | grep -o '"name": *"code"[^}]*"detail": *{[^}]*"page_count": *[0-9]*' \\
        | grep -o '"page_count": *[0-9]*' | grep -o '[0-9]\\+' | head -1)
      _CWD_PAGES=\${_CWD_PAGES:-0}
    fi
    if [ "$_CWD_PAGES" -gt 0 ] 2>/dev/null; then
      echo "GBrain configured. Prefer \\\`gbrain search\\\`/\\\`gbrain query\\\` over Grep for"
      echo "semantic questions; use \\\`gbrain code-def\\\`/\\\`code-refs\\\`/\\\`code-callers\\\` for"
      echo "symbol-aware code lookup. See \\"## GBrain Search Guidance\\" in CLAUDE.md."
      echo "Run /sync-gbrain to refresh."
    else
      echo "GBrain configured but this repo isn't indexed yet. Run \\\`/sync-gbrain --full\\\`"
      echo "before relying on \\\`gbrain search\\\` for code questions in this repo."
      echo "Falls back to Grep until indexed."
    fi
  fi
fi

_BRAIN_SYNC_MODE=$("$_BRAIN_CONFIG_BIN" get gbrain_sync_mode 2>/dev/null || echo off)

if [ -f "$_BRAIN_REMOTE_FILE" ] && [ ! -d "$_GSTACK_HOME/.git" ] && [ "$_BRAIN_SYNC_MODE" = "off" ]; then
  _BRAIN_NEW_URL=$(head -1 "$_BRAIN_REMOTE_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$_BRAIN_NEW_URL" ]; then
    echo "BRAIN_SYNC: brain repo detected: $_BRAIN_NEW_URL"
    echo "BRAIN_SYNC: run 'gstack-brain-restore' to pull your cross-machine memory (or 'gstack-config set gbrain_sync_mode off' to dismiss forever)"
  fi
fi

if [ -d "$_GSTACK_HOME/.git" ] && [ "$_BRAIN_SYNC_MODE" != "off" ]; then
  _BRAIN_LAST_PULL_FILE="$_GSTACK_HOME/.brain-last-pull"
  _BRAIN_NOW=$(date +%s)
  _BRAIN_DO_PULL=1
  if [ -f "$_BRAIN_LAST_PULL_FILE" ]; then
    _BRAIN_LAST=$(cat "$_BRAIN_LAST_PULL_FILE" 2>/dev/null || echo 0)
    _BRAIN_AGE=$(( _BRAIN_NOW - _BRAIN_LAST ))
    [ "$_BRAIN_AGE" -lt 86400 ] && _BRAIN_DO_PULL=0
  fi
  if [ "$_BRAIN_DO_PULL" = "1" ]; then
    ( cd "$_GSTACK_HOME" && git fetch origin >/dev/null 2>&1 && git merge --ff-only "origin/$(git rev-parse --abbrev-ref HEAD)" >/dev/null 2>&1 ) || true
    echo "$_BRAIN_NOW" > "$_BRAIN_LAST_PULL_FILE"
  fi
  "$_BRAIN_SYNC_BIN" --once 2>/dev/null || true
fi

if [ -d "$_GSTACK_HOME/.git" ] && [ "$_BRAIN_SYNC_MODE" != "off" ]; then
  _BRAIN_QUEUE_DEPTH=0
  [ -f "$_GSTACK_HOME/.brain-queue.jsonl" ] && _BRAIN_QUEUE_DEPTH=$(wc -l < "$_GSTACK_HOME/.brain-queue.jsonl" | tr -d ' ')
  _BRAIN_LAST_PUSH="never"
  [ -f "$_GSTACK_HOME/.brain-last-push" ] && _BRAIN_LAST_PUSH=$(cat "$_GSTACK_HOME/.brain-last-push" 2>/dev/null || echo never)
  echo "BRAIN_SYNC: mode=$_BRAIN_SYNC_MODE | last_push=$_BRAIN_LAST_PUSH | queue=$_BRAIN_QUEUE_DEPTH"
else
  echo "BRAIN_SYNC: off"
fi
\`\`\`

${isBrainHost ? `If output shows \`BRAIN_SYNC: brain repo detected\`, offer \`gstack-brain-restore\` via AskUserQuestion; otherwise continue.` : ''}

Privacy stop-gate: if output shows \`BRAIN_SYNC: off\`, \`gbrain_sync_mode_prompted\` is \`false\`, and gbrain is on PATH or \`gbrain doctor --fast --json\` works, ask once:

> gstack can publish your session memory to a private GitHub repo that GBrain indexes across machines. How much should sync?

Options:
- A) Everything allowlisted (recommended)
- B) Only artifacts
- C) Decline, keep everything local

After answer:

\`\`\`bash
# Chosen mode: full | artifacts-only | off
"$_BRAIN_CONFIG_BIN" set gbrain_sync_mode <choice>
"$_BRAIN_CONFIG_BIN" set gbrain_sync_mode_prompted true
\`\`\`

If A/B and \`~/.gstack/.git\` is missing, ask whether to run \`gstack-brain-init\`. Do not block the skill.

At skill END before telemetry:

\`\`\`bash
"${ctx.paths.binDir}/gstack-brain-sync" --discover-new 2>/dev/null || true
"${ctx.paths.binDir}/gstack-brain-sync" --once 2>/dev/null || true
\`\`\`
`;
}
