/**
 * Whole-file E2E tier gate — the single definition of the
 * `EVALS=1 && EVALS_TIER === '<tier>'` predicate that tier-gated paid test
 * files used to copy-paste (~36 local copies before consolidation).
 *
 * This module MUST stay side-effect-free. It is imported at module scope by
 * every tier-gated test file, including files the sharded paid runner
 * (scripts/test-paid-shards.ts) spawns one-process-each — unlike
 * test/helpers/e2e-helpers.ts, whose EVALS=1 module-scope work includes a
 * ~30s `claude -p` connectivity ping, diff-based selection, and ~/.gstack
 * pre-seeding. The only import allowed here is `bun:test`.
 * test/helpers/e2e-gate.unit.test.ts enforces this with a source scan.
 *
 * Env is read at CALL time (the importing test file's module top-level), not
 * captured at this module's load time, so the gate behaves identically under
 * single-process `bun test` globs and the sharded runner's per-shard env.
 *
 * Static-grep consumers that must recognize the call shape
 * `describeE2ETier('<tier>')` / `e2eTierEnabled('<tier>')` alongside the raw
 * `EVALS_TIER === '<tier>'` predicate:
 *   - test/e2e-tier-alignment.test.ts (HELPER_GATE_RE) — tier-alignment invariant
 *   - scripts/test-paid-shards.ts classifyPaidTestFile — pre-spawn tier exclusion
 */

import { describe } from 'bun:test';

export type E2ETier = 'gate' | 'periodic';

/**
 * True when this process should run whole-file-gated paid tests of `tier`:
 * EVALS=1 AND EVALS_TIER exactly equals the tier.
 *
 * Deliberate consequence: EVALS=1 with EVALS_TIER unset is false for BOTH
 * tiers. Tierless runs (`test:evals` / `eval:bg` / `eval:bg:all`) skip every
 * tier-gated file and rely on diff-based per-test selection instead — that is
 * the long-standing behavior of the copy-pasted predicates, pinned by
 * test/helpers/e2e-gate.unit.test.ts.
 */
export function e2eTierEnabled(tier: E2ETier): boolean {
  return !!process.env.EVALS && process.env.EVALS_TIER === tier;
}

/**
 * `describe` when `e2eTierEnabled(tier)`, else `describe.skip`.
 *
 * Usage (module top-level of a tier-gated test file):
 *   const describeE2E = describeE2ETier('periodic');
 */
export function describeE2ETier(tier: E2ETier): typeof describe | typeof describe.skip {
  return e2eTierEnabled(tier) ? describe : describe.skip;
}
