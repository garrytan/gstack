/**
 * Oracle — Product Conscience resolvers.
 *
 * PRODUCT_CONSCIENCE_READ: injected into planning/analysis skills.
 *   Tells the skill to read docs/oracle/PRODUCT_MAP.md and use it for context.
 *
 * PRODUCT_CONSCIENCE_WRITE: injected into post-work skills.
 *   Tells the skill to silently update the product map after completing work.
 *
 * Both are intentionally lean (~10 lines of output each). The product map
 * is self-describing — its header contains the schema and instructions.
 * Intelligence lives in the data, not in these resolver outputs.
 */

import type { TemplateContext } from './types';

export function generateProductConscienceRead(_ctx: TemplateContext): string {
  return `## Product Conscience — Read

\`\`\`bash
_PMAP="docs/oracle/PRODUCT_MAP.md"
[ -f "$_PMAP" ] && echo "PRODUCT_MAP: found" || echo "PRODUCT_MAP: none"
\`\`\`

If PRODUCT_MAP found: read \`docs/oracle/PRODUCT_MAP.md\`. The map is self-documenting —
its header explains the schema. Use the Product Arc, Features, Patterns, and Anti-Patterns
to inform your work. Spot-check 2-3 components mentioned in the map by grepping the
codebase to verify accuracy. If an anti-pattern matches what you're about to do, warn
the user.

If no PRODUCT_MAP: note that \`/oracle\` can bootstrap one from the codebase. Do not block
on this — proceed with the skill's normal workflow.

---`;
}

export function generateProductConscienceWrite(ctx: TemplateContext): string {
  const slugCmd = `${ctx.paths.binDir}/gstack-slug 2>/dev/null`;

  return `## Product Conscience — Write

After completing the skill's main work, silently update the product map if it exists.

\`\`\`bash
_PMAP="docs/oracle/PRODUCT_MAP.md"
[ -f "$_PMAP" ] && echo "PRODUCT_MAP_WRITE: updating" || echo "PRODUCT_MAP_WRITE: skipped (no map)"
eval "$(${slugCmd})" 2>/dev/null || true
\`\`\`

If PRODUCT_MAP exists: update \`docs/oracle/PRODUCT_MAP.md\` following the schema in its
header. Update the feature entry for what changed in this session — adjust lifecycle status
(PLANNED → BUILDING → SHIPPED), add discovered patterns or anti-patterns, update connections.
Compress features shipped >3 months ago with no \`depends_on\` references to one-liners.
Do NOT ask the user — this is a silent write.

Then write the breadcrumb:
\`\`\`bash
eval "$(${slugCmd})" 2>/dev/null && mkdir -p ~/.gstack/projects/$SLUG && date -u +%Y-%m-%dT%H:%M:%SZ > ~/.gstack/projects/$SLUG/.product-map-last-write 2>/dev/null || true
\`\`\`

If no PRODUCT_MAP: skip silently. Do not create one — that's \`/oracle bootstrap\`.`;
}
