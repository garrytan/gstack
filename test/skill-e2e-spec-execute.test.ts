/**
 * /spec --execute end-to-end (periodic, paid, real-PTY).
 *
 * Asserts: when /spec --execute runs against a fixture prompt, it:
 *   1. Refuses to draft on turn 1 (Phase 1 hard gate)
 *   2. Reads code in Phase 3 (cites a real file path from the fixture repo)
 *   3. Passes the quality gate (score >= 7) on a well-formed fixture
 *   4. Spawns a fresh worktree on branch spec/<slug>-<pid>
 *   5. Issues a final-confirm AskUserQuestion before the spawn
 *
 * Cost: ~$3-5/run, 5-8 min wall clock. Periodic — runs weekly via cron or
 *       on demand via `EVALS=1 EVALS_TIER=periodic bun run test:e2e`.
 *
 * TODO (v1.1): expand to test all 5 expansion paths and the plan-mode-aware
 * Phase 5 branching (active vs inactive). Current implementation is the
 * minimum smoke that proves --execute end-to-end works.
 */

import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';

const describeE2E = describeE2ETier('periodic');

describeE2E('/spec --execute end-to-end (periodic)', () => {
  // test.todo, not expect(true): the placeholder reported PASS on every
  // periodic run while asserting nothing — a lying green with a 600s budget.
  // The file itself stays: it is the periodic-tier surface registered in
  // E2E_TIERS so the diff-based selector runs it when spec/ changes, and
  // the deterministic template-invariant coverage in
  // spec-template-invariants.test.ts + spec-template-sync.test.ts gates the
  // gate tier. Implementation spec for the real PTY-driven test lives in
  // the header TODO ("/spec --execute E2E full pipeline test (v1.1)").
  test.todo('phase gating + magical Phase 3 + quality gate + spawn — full pipeline');
});
