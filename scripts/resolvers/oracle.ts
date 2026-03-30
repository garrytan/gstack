/**
 * Oracle — Product Conscience resolvers.
 *
 * PRODUCT_CONSCIENCE_READ: injected into planning/analysis skills.
 *   Tells the skill to read docs/oracle/PRODUCT_MAP.md and use it for context.
 *   Auto-bootstraps a minimal product map on first encounter if repo has >=20 commits.
 *
 * PRODUCT_CONSCIENCE_WRITE: injected into post-work skills.
 *   Tells the skill to silently update the product map after completing work.
 *   Progressively enriches compressed entries into full entries.
 *
 * Both are intentionally lean. The product map is self-describing — its header
 * contains the schema and instructions. Intelligence lives in the data, not
 * in these resolver outputs.
 */

import type { TemplateContext } from './types';

export function generateProductConscienceRead(ctx: TemplateContext): string {
  const slugCmd = `${ctx.paths.binDir}/gstack-slug 2>/dev/null`;

  return `## Product Conscience — Read

\`\`\`bash
_PMAP="docs/oracle/PRODUCT_MAP.md"
if [ -f "$_PMAP" ]; then
  echo "PRODUCT_MAP: found"
else
  eval "$(${slugCmd})" 2>/dev/null || true
  _BOOTSTRAPPED="no"
  [ -n "$SLUG" ] && [ -f ~/.gstack/projects/$SLUG/.product-map-auto-bootstrapped ] && _BOOTSTRAPPED="yes"
  _COMMITS=$(git rev-list --count HEAD 2>/dev/null || echo "0")
  if [ "$_BOOTSTRAPPED" = "yes" ]; then
    echo "PRODUCT_MAP: none (previously bootstrapped)"
  elif [ "$_COMMITS" -ge 20 ]; then
    echo "PRODUCT_MAP: bootstrap-ready $_COMMITS"
  else
    echo "PRODUCT_MAP: none (repo has $_COMMITS commits, need 20+)"
  fi
fi
\`\`\`

If PRODUCT_MAP **found**: read \`docs/oracle/PRODUCT_MAP.md\`. Check the first feature entry:
- If entries have full fields (Purpose, Category, Components, etc.): spot-check 2-3
  components by grepping the codebase. Warn if an anti-pattern matches planned work.
- If entries are compressed one-liners: read the Product Arc and feature list for context.
  Skip spot-checking (compressed entries don't list components).

If PRODUCT_MAP is **bootstrap-ready**: auto-bootstrap a minimal product map. This is
silent, do NOT ask the user. Under 60 seconds. Git log analysis only, no file reading,
no scanner, no component trees.

1. Run these commands:
\`\`\`bash
git log --oneline -50
git log --since=6.months --name-only --format="" | sort | uniq -c | sort -rn | head -20
\`\`\`
2. Identify features from the output. Write a minimal \`docs/oracle/PRODUCT_MAP.md\`:
   - \`<!-- schema_version: 1 -->\` header
   - \`## Product Arc\` (2-3 sentences from git history)
   - \`## Features\` (compressed one-liner per feature)
   - \`## Reusable Patterns\` ("None mapped yet")
   - \`## Anti-Patterns\` ("None mapped yet")
   - \`## Identity\` (category percentages or "Suppressed")
\`\`\`bash
mkdir -p docs/oracle
\`\`\`
3. Write breadcrumbs:
\`\`\`bash
eval "$(${slugCmd})" 2>/dev/null || true
[ -n "$SLUG" ] && mkdir -p ~/.gstack/projects/$SLUG && touch ~/.gstack/projects/$SLUG/.product-map-auto-bootstrapped && date -u +%Y-%m-%dT%H:%M:%SZ > ~/.gstack/projects/$SLUG/.product-map-last-write
\`\`\`
4. Tell the user: "Product conscience activated — {N} features mapped. Run \`/oracle inventory\` for deeper analysis."
5. Then read the map you just created and use it for context (compressed sub-path above).

If PRODUCT_MAP is **none (previously bootstrapped)**: user may have deleted the map.
Proceed without product context.

If PRODUCT_MAP is **none (repo has N commits, need 20+)**: repo too young.
Proceed without product context.

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
_INV_NUDGED="no"
[ -n "$SLUG" ] && [ -f ~/.gstack/projects/$SLUG/.oracle-inventory-nudged ] && _INV_NUDGED="yes"
echo "INVENTORY_NUDGED: $_INV_NUDGED"
\`\`\`

If PRODUCT_MAP exists: update \`docs/oracle/PRODUCT_MAP.md\` following the schema in its
header. Update the feature entry for what changed in this session — adjust lifecycle status
(PLANNED → BUILDING → SHIPPED), add discovered patterns or anti-patterns, update connections.
Compress features shipped >3 months ago with no \`depends_on\` references to one-liners.
Do NOT ask the user — this is a silent write.

If the feature entry you just worked on is in compressed one-liner format (auto-bootstrapped),
expand it to the full schema with all fields (Purpose, Category, Data, Patterns, Components,
Decisions, Connections, Depends on, Anti-patterns, Shipped). You have context from this
session's work to fill in accurate details.

Then write the breadcrumb:
\`\`\`bash
eval "$(${slugCmd})" 2>/dev/null && mkdir -p ~/.gstack/projects/$SLUG && date -u +%Y-%m-%dT%H:%M:%SZ > ~/.gstack/projects/$SLUG/.product-map-last-write 2>/dev/null || true
\`\`\`

If \`INVENTORY_NUDGED\` is "no" and the map has mostly compressed one-liner entries:
tell the user "Tip: Run \`/oracle inventory\` for a deeper page-by-page analysis."
Then mark as nudged:
\`\`\`bash
[ -n "$SLUG" ] && touch ~/.gstack/projects/$SLUG/.oracle-inventory-nudged 2>/dev/null || true
\`\`\`

If no PRODUCT_MAP: skip silently. Do not create one — that's \`/oracle bootstrap\`.`;
}
