/**
 * Timeout policy for paid tests — five tiers instead of hand-tuned sprawl.
 *
 * Before this module the paid suite carried 46×300s, 46×120s, 44×360s,
 * 44×180s, 27×240s, 19×150s, 13×420s, 12×600s, 7×700s… hand-ratcheted
 * per test, several inflated to paper over the old 40-way in-shard
 * concurrency (session startup queued behind 39 siblings and ate the
 * budget before turn one — dead with the sharded runner's 1-file-per-shard
 * model). Pick the tier that matches the test's SHAPE; escape-hatch raw
 * literals stay legal with a justification comment (count-ratcheted by
 * test/eval-budgets-policy.test.ts).
 *
 * Every tier must fit inside the lane walls — pinned by the fit test in
 * test/eval-budgets-policy.test.ts against the sharded runner's
 * DEFAULT_SHARD_TIMEOUT_MS. Budget above the wall is fiction, not headroom.
 */

/** LLM-judge call over an existing capture (no agent session). */
export const JUDGE_MS = 120_000;

/** One `claude -p` / SDK capture, bounded turns. */
export const CAPTURE_MS = 300_000;

/** Multi-capture or long multi-turn `claude -p` flows. */
export const CAPTURE_LONG_MS = 600_000;

/** Interactive real-PTY flow (spawn + skill + a few interactions). */
export const PTY_MS = 900_000;

/**
 * Chained/judged PTY observation — the ceiling tier. 1200s leaves the
 * 1800s shard wall real overhead; anything that genuinely needs more
 * should be split or use an explicitly registered workflow exception with
 * corresponding runner and CI walls; never inflate an ordinary tier.
 */
export const PTY_LONG_MS = 1_200_000;

export const ALL_TIERS = {
  JUDGE_MS,
  CAPTURE_MS,
  CAPTURE_LONG_MS,
  PTY_MS,
  PTY_LONG_MS,
} as const;

/**
 * Explicit exception for one uninterrupted four-phase workflow. These are
 * specified allowances, not measured latency or a conservative confidence bound.
 * The historical 900-second failure remains a failure. Ordinary tiers do not grow.
 */
export const AUTOPLAN_CHAIN_BUDGET = {
  id: 'autoplan-four-native-phases-v1',
  file: 'test/skill-e2e-autoplan-chain.test.ts',
  workMs: 4 * PTY_LONG_MS,
  sessionMs: 84 * 60_000,
  testMs: 85 * 60_000,
  shardMs: 172 * 60_000,
  retries: 1,
  shardReserveMs: 2 * 60_000,
  ciJobMs: 200 * 60_000,
  ciReserveMs: 28 * 60_000,
  reason: 'One command must complete CEO, Design, DX and Eng, including native reviews and amendment handoffs.',
} as const;

/** The only registered over-tier test budget; arbitrary per-file escapes fail. */
export function assertPaidTestBudget(file: string, ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0 ||
      (ms > PTY_LONG_MS * 1.25 &&
       (file !== AUTOPLAN_CHAIN_BUDGET.file || ms !== AUTOPLAN_CHAIN_BUDGET.testMs))) {
    throw new Error(`Unregistered paid test budget: ${file}: ${ms}`);
  }
}
