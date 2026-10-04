/**
 * {{DESIGN_DOC_DISCOVERY}} — the canonical design-doc discovery block.
 *
 * One invocation of bin/gstack-design-doc-find, which owns the precedence
 * (newest branch-scoped doc in the state root's project directory, then the
 * newest project-scoped doc, then the newest repo-local docs/designs/*.md when
 * it is at least as fresh; a root DESIGN.md is the design system, never the doc) and resolves the state root through
 * bin/gstack-paths. Plan reviews, autoplan and the prerequisite-skill re-check
 * in spec-review.ts all render this one block, so they agree on which doc wins.
 *
 * The fragment carries no code fences — the {{DESIGN_DOC_DISCOVERY}} token
 * sits inside each caller's ```bash block. Callers must set $SLUG and
 * $BRANCH first; the block sets $DESIGN and prints "Design doc found: ..." or
 * "No design doc found".
 */

import type { TemplateContext } from './types';

/**
 * Raw canonical fragment, exported so TS resolvers (spec-review.ts's
 * prerequisite re-check) can interpolate it into their own template strings.
 */
export const DESIGN_DOC_DISCOVERY_BLOCK = `DESIGN=$(~/.claude/skills/gstack/bin/gstack-design-doc-find "$SLUG" "$BRANCH")
[ -n "$DESIGN" ] && echo "Design doc found: $DESIGN" || echo "No design doc found"`;

export function generateDesignDocDiscovery(_ctx: TemplateContext): string {
  return DESIGN_DOC_DISCOVERY_BLOCK;
}
