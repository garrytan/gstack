import type { TemplateContext } from '../types';

export function generateContextRecovery(ctx: TemplateContext): string {
  const binDir = ctx.paths.binDir; // env-var hosts already resolve to $GSTACK_BIN via types.ts

  // Artifact paths remain on the legacy gstack-slug projection. Ledger reads
  // go through their canonical-identity adapters so they union only explicit
  // legacy candidates and reject conflicting repository identities.
  return `## Context Recovery

At session start or after compaction, recover recent project context.

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)"
_PROJ="\${GSTACK_HOME:-$HOME/.gstack}/projects/\${SLUG:-unknown}"
_REVIEW_COUNT=$(${binDir}/gstack-review-read 2>/dev/null | awk '/^---CONFIG---$/{exit} /^\\{/{n++} END{print n+0}')
_TIMELINE=$(${binDir}/gstack-timeline-read --limit 5 --branch "$_BRANCH" 2>/dev/null)
if [ -d "$_PROJ" ] || [ "\${_REVIEW_COUNT:-0}" -gt 0 ] || [ -n "$_TIMELINE" ]; then
  echo "--- RECENT ARTIFACTS ---"
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -3
  [ "\${_REVIEW_COUNT:-0}" -gt 0 ] && echo "REVIEWS: $_REVIEW_COUNT entries"
  [ -n "$_TIMELINE" ] && printf '%s\\n' "$_TIMELINE"
  if [ -n "$_TIMELINE" ]; then
    _LAST=$(printf '%s\\n' "$_TIMELINE" | grep ' completed' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    _RECENT_SKILLS=$(printf '%s\\n' "$_TIMELINE" | grep ' completed' | tail -3 | sed -n 's/.* \/\\([^ ]*\\) completed.*/\\1/p' | tr '\\n' ',')
    [ -n "$_RECENT_SKILLS" ] && echo "RECENT_PATTERN: $_RECENT_SKILLS"
  fi
  _LATEST_CP=$(find "$_PROJ/checkpoints" -name "*.md" -type f 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  [ -n "$_LATEST_CP" ] && echo "LATEST_CHECKPOINT: $_LATEST_CP"
  if [ -f "$_PROJ/decisions.active.json" ]; then
    echo "--- ACTIVE DECISIONS (recent, scope-relevant) ---"
    ${binDir}/gstack-decision-search --recent 5 2>/dev/null
    echo "--- END DECISIONS ---"
  fi
  echo "--- END ARTIFACTS ---"
fi
\`\`\`

If artifacts are listed, read the newest useful one. If \`LAST_SESSION\` or \`LATEST_CHECKPOINT\` appears, give a 2-sentence welcome back summary. If \`RECENT_PATTERN\` clearly implies a next skill, suggest it once.

**Cross-session decisions.** If \`ACTIVE DECISIONS\` are listed, treat them as prior settled calls with their rationale — do not silently re-litigate them; if you're about to reverse one, say so explicitly. Reach for \`${binDir}/gstack-decision-search\` whenever a question touches a past decision ("what did we decide / why / did we try"). When you or the user make a DURABLE decision (architecture, scope, tool/vendor choice, or a reversal) — NOT a turn-level or trivial choice — log it with \`${binDir}/gstack-decision-log\` (\`--supersede <id>\` for a reversal). Reliable and local; gbrain not required.`;
}
