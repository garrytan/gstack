/**
 * {{DESIGN_DOC_DISCOVERY}} — the canonical design-doc discovery block (#703).
 *
 * Finds the design doc a plan review should read: newest branch-scoped doc
 * under ~/.gstack/projects/<slug>/, falling back to newest project-scoped
 * doc, then lets a repo-local doc (docs/designs/*.md) win when it is at
 * least as fresh. office-hours dual-writes docs/designs/ alongside ~/.gstack,
 * and the committed copy is what teammates see — but a stale old repo doc
 * must never shadow a newer private session. A root DESIGN.md is never a
 * design doc: since the open DESIGN.md format it is the design system that
 * /design-consultation writes, and the plan reviews want the problem
 * statement, not the token file (#2839).
 *
 * Single source of truth for the freshness-preference logic that previously
 * lived verbatim in plan-ceo-review, plan-eng-review, plan-devex-review, and
 * the prerequisite-skill re-check in review.ts (GStack 2 fork-port wave,
 * time-attack/gstack). Drift between copies meant plan reviews could
 * disagree about which design doc wins.
 *
 * The fragment carries no code fences — the {{DESIGN_DOC_DISCOVERY}} token
 * sits inside each caller's ```bash block. Callers must set $SLUG and
 * $BRANCH first (and `setopt +o nomatch` for zsh); the block sets $DESIGN
 * and prints "Design doc found: ..." or "No design doc found".
 */

import type { TemplateContext } from './types';

/**
 * Raw canonical fragment, exported so TS resolvers (review.ts's prerequisite
 * re-check) can interpolate it into their own template strings instead of
 * embedding a drifting copy.
 */
export const DESIGN_DOC_DISCOVERY_BLOCK = `_LOCALDOC=$(ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-design-*.md 2>/dev/null | head -1)
[ -z "$_LOCALDOC" ] && _LOCALDOC=$(ls -t ~/.gstack/projects/$SLUG/*-design-*.md 2>/dev/null | head -1)
# Repo-local docs win when at least as fresh (#703): office-hours dual-writes
# docs/designs/ alongside ~/.gstack, and the committed copy is what teammates
# see. A stale old repo doc never shadows a newer private session. Only
# docs/designs/ is a design doc: a root DESIGN.md is the design system that
# /design-consultation writes, and reading it here reviews a plan against a
# token file while printing "Design doc found" (#2839).
_REPOTOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
_REPODOC=""
if [ -n "$_REPOTOP" ]; then
  _REPODOC=$(ls -t "$_REPOTOP"/docs/designs/*.md 2>/dev/null | head -1)
fi
DESIGN="$_LOCALDOC"
if [ -n "$_REPODOC" ] && { [ -z "$_LOCALDOC" ] || [ "$_REPODOC" -nt "$_LOCALDOC" ]; }; then
  DESIGN="$_REPODOC"
fi
[ -n "$DESIGN" ] && echo "Design doc found: $DESIGN" || echo "No design doc found"`;

export function generateDesignDocDiscovery(_ctx: TemplateContext): string {
  return DESIGN_DOC_DISCOVERY_BLOCK;
}
