import type { TemplateContext } from '../types';

export function generateContextRecovery(ctx: TemplateContext): string {
  const binDir = ctx.paths.binDir; // env-var hosts already resolve to $GSTACK_BIN via types.ts

  // Branch-form discipline (#2550/#1851): FILE-PATH positions use $BRANCH —
  // the canonical slug form the gstack-slug eval on the first line sets
  // (tr '/' '-' then tr -cd 'a-zA-Z0-9._-', matching what gstack-review-log
  // WRITES). The timeline.jsonl greps keep raw $_BRANCH because the timeline
  // writer (preamble's gstack-timeline-log call) stores the raw branch in the
  // "branch" field — slugging the reader there would break matching.
  return `## Context Recovery

At session start or after compaction, recover recent project context.

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)"
_PROJ="\${GSTACK_HOME:-$HOME/.gstack}/projects/\${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -3
  [ -f "$_PROJ/\${BRANCH:-unknown}-reviews.jsonl" ] && echo "REVIEWS: $(wc -l < "$_PROJ/\${BRANCH:-unknown}-reviews.jsonl" | tr -d ' ') entries"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  if [ -f "$_PROJ/timeline.jsonl" ]; then
    _LAST=$(grep "\\"branch\\":\\"\${_BRANCH}\\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    _RECENT_SKILLS=$(grep "\\"branch\\":\\"\${_BRANCH}\\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -3 | grep -o '"skill":"[^"]*"' | sed 's/"skill":"//;s/"//' | tr '\\n' ',')
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
