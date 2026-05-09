

export function generateCompletenessSection(): string {
  return `## Completeness Principle — Boil the Lake

AI makes completeness cheap. Recommend complete lakes (tests, edge cases, error paths); flag oceans (rewrites, multi-quarter migrations).

When options differ in coverage, include \`Completeness: X/10\` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate scores.`;
}
