

export function generateCompletenessSection(): string {
  return `## Completeness Principle — Boil the Ocean

AI makes completeness cheap. The old "ocean" framing — rewrites and multi-quarter migrations that were too big to attempt — no longer applies when one person + AI ships in hours what teams used to take months for. Recommend the complete thing (tests, edge cases, error paths, full rewrites when warranted). Only flag work whose blocker is non-engineering time: multi-team coordination, regulatory approval, data that needs months to accumulate.

When options differ in coverage, include \`Completeness: X/10\` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate scores.`;
}
