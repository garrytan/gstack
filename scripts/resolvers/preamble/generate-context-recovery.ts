import type { TemplateContext } from '../types';

export function generateContextRecovery(ctx: TemplateContext): string {
  const binDir = ctx.paths.binDir; // env-var hosts already resolve to $GSTACK_BIN via types.ts

  // Branch-form discipline (#2550/#1851): FILE-PATH positions use $BRANCH —
  // the canonical slug form the gstack-slug eval on the first line sets
  // (tr '/' '-' then tr -cd 'a-zA-Z0-9._-', matching what gstack-review-log
  // WRITES). Initialize raw $_BRANCH here: skill-start runs in a separate
  // process. Keep the timeline writer's slash-preserving allowlist and fallback;
  // using the filename slug in the "branch" field would break matching.
  return `## Context Recovery

At session start or after compaction, recover recent project context.

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)"
_BRANCH=$(git branch --show-current 2>/dev/null | tr -cd 'a-zA-Z0-9._/-') || :; _BRANCH=\${_BRANCH:-unknown}
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

**Cross-session decisions.** Honor listed \`ACTIVE DECISIONS\` and their rationale; do not silently re-litigate them, and announce planned reversals. Use \`${binDir}/gstack-decision-search\` for past-decision questions. Log DURABLE decisions by you or the user (architecture, scope, tool/vendor choice, reversal; not trivial or turn-level choices) with \`${binDir}/gstack-decision-log\` (\`--supersede <id>\` for reversals). Reliable and local; gbrain not required.`;
}
