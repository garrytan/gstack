import type { TemplateContext } from '../types';

export function generateCompletenessSection(ctx?: TemplateContext): string {
  if (ctx?.explainLevel === 'terse') return '';
  return `## Completeness Principle — Boil the Ocean

AI makes completeness cheap, so the complete thing is the goal. Recommend full coverage (tests, edge cases, error paths) — boil the ocean one lake at a time. The only thing out of scope is genuinely unrelated work (rewrites, multi-quarter migrations); flag that as separate scope, never as an excuse for a shortcut.

When options differ in coverage, include \`Completeness: X/10\` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate scores.`;
}
