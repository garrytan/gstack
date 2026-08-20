#!/usr/bin/env bun
// detect-bump — crude heuristic for picking a bump level from a VERSION pair.
// Used by CI's version-gate job to re-run the util with the "same" level that
// /ship used, without needing persisted bump-intent.
//
// Input:  two VERSION strings via argv: current (base) and target (branch).
// Output: a single word: major|minor|patch|micro
//
// Heuristic: compare slot-by-slot. The first slot that differs IS the level.
// If nothing differs (shouldn't happen when called by CI gate — the whole point
// is the branch bumped VERSION), default to "patch".

function detect(a: string, b: string): string {
  const pa = a.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const pb = b.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!pa || !pb) return "patch";
  const [, a1, a2, a3, a4] = pa;
  const [, b1, b2, b3, b4] = pb;
  if (a1 !== b1) return "major";
  if (a2 !== b2) return "minor";
  if (a3 !== b3) return "patch";
  if (a4 !== b4) return "micro";
  return "patch";
}

const [, , base, target] = process.argv;
if (!base || !target) {
  console.error("Usage: detect-bump <base-version> <branch-version>");
  process.exit(2);
}
console.log(detect(base, target));
