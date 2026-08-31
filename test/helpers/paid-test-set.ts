/**
 * The ONE definition of which test files are paid (API spend, external
 * services, e2e harnesses). package.json's test:gate/test:evals globs, the
 * free-suite exclusion in scripts/test-free-shards.ts, and the sharded paid
 * runner in scripts/test-paid-shards.ts all derive from this list — a file
 * added to one and not the others either burns money in the free suite or
 * silently never runs in the paid tier.
 */

import { matchGlob } from './touchfiles';

/** The exact globs package.json's `test:gate` passes to `bun test`. */
export const PAID_TEST_GLOBS = [
  // skill-llm-eval* (not just the base file): skill-llm-eval-spec.test.ts
  // fell outside the exact glob and could never run in any lane.
  'test/skill-llm-eval*.test.ts',
  'test/skill-e2e-*.test.ts',
  'test/skill-routing-e2e.test.ts',
  // codex-e2e* (was two exact names): codex-e2e-plan-format.test.ts and
  // codex-e2e-recommendation-substance.test.ts were API-spending orphans —
  // outside these globs they self-skipped in the free suite AND never
  // entered the paid census. The same bug class as the deleted pre-split
  // monolith (see test/paid-shards.test.ts's regression pin).
  'test/codex-e2e*.test.ts',
  'test/gemini-e2e.test.ts',
  'test/llm-judge-recommendation.test.ts',
  'test/carve-section-loading.test.ts',
] as const;

/** True when a repo-relative path (either slash style) is a paid test file. */
export function isPaidTestFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return PAID_TEST_GLOBS.some((glob) => matchGlob(normalized, glob));
}
