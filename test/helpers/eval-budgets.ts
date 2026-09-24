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

/** One bounded capture: SDK execution or the first displayed native question. */
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

/** Whole-file supervision must cover each existing attempt and its retry.
 * These six fixtures already allow 25 minutes per case; the old 30-minute
 * wall could kill a second attempt after five minutes. No case budget grows.
 * Reserve the sequential upper bound even when Bun runs sibling cases together.
 */
export const FINDING_RETRY_BUDGETS = [
  { file: 'test/skill-e2e-plan-ceo-finding-count.test.ts', cases: 2 },
  { file: 'test/skill-e2e-plan-ceo-split-overflow.test.ts', cases: 1 },
  { file: 'test/skill-e2e-plan-design-finding-count.test.ts', cases: 1 },
  { file: 'test/skill-e2e-plan-devex-finding-count.test.ts', cases: 1 },
  { file: 'test/skill-e2e-plan-eng-finding-count.test.ts', cases: 1 },
  { file: 'test/skill-e2e-plan-eng-multi-finding-batching.test.ts', cases: 1 },
].map(({ file, cases }) => ({
  file, cases,
  id: `${file.slice('test/skill-e2e-'.length, -'.test.ts'.length)}-existing-retry-v1`,
  testMs: 1_500_000,
  retries: 1,
  shardReserveMs: AUTOPLAN_CHAIN_BUDGET.shardReserveMs,
  shardMs: cases * 1_500_000 * 2 + AUTOPLAN_CHAIN_BUDGET.shardReserveMs,
}));

/** Three existing captures and one configured retry; only supervision grows. */
export const AUQ_CONSISTENCY_RETRY_BUDGET = {
  file: 'test/skill-e2e-auq-consistency.test.ts',
  id: 'auq-consistency-existing-retry-v1',
  cases: 1,
  testMs: 3 * CAPTURE_MS + 60_000,
  retries: 1,
  shardReserveMs: AUTOPLAN_CHAIN_BUDGET.shardReserveMs,
  shardMs: (3 * CAPTURE_MS + 60_000) * 2 + AUTOPLAN_CHAIN_BUDGET.shardReserveMs,
} as const;

/** These fixtures have a fixed case count in every supported tier. */
export const STRICT_RETRY_CASE_BUDGETS = [...FINDING_RETRY_BUDGETS, AUQ_CONSISTENCY_RETRY_BUDGET];

/** Whole-file walls cover all existing cases and retries, even if Bun runs them
 * sequentially. Mixed-tier files reserve their larger complete tier, never a
 * currently selected subset. These rows add no case-count or model-work policy.
 * The 10-second terms preserve the existing Codex/recording finalization grace.
 */
export const FILE_RETRY_BUDGETS = [
  ...STRICT_RETRY_CASE_BUDGETS,
  ...[
    // Fourteen workflow judges include their 10s recording grace; the other
    // eleven judges retain 120s. Supervise all 25 and the existing one retry.
    { file: 'test/skill-llm-eval.test.ts', attemptMs: 15 * (JUDGE_MS + 10_000) + 11 * JUDGE_MS, retries: 1 },
    { file: 'test/codex-e2e-plan-format.test.ts', attemptMs: 4 * (CAPTURE_LONG_MS + 10_000), retries: 1 },
    { file: 'test/skill-e2e-auq-matrix.test.ts', attemptMs: 6 * CAPTURE_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-format.test.ts', attemptMs: 4 * (CAPTURE_MS + 10_000), retries: 1 },
    { file: 'test/skill-e2e-auto-decide-preserved.test.ts', attemptMs: PTY_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-ceo-finding-floor.test.ts', attemptMs: PTY_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-eng-finding-floor.test.ts', attemptMs: PTY_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-design-finding-floor.test.ts', attemptMs: PTY_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-devex-finding-floor.test.ts', attemptMs: PTY_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-mode-no-op.test.ts', attemptMs: 5 * CAPTURE_LONG_MS, retries: 2 },
    { file: 'test/skill-e2e-plan-ceo-mode-routing.test.ts', attemptMs: 2 * CAPTURE_LONG_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-eng-plan-mode.test.ts', attemptMs: 2 * CAPTURE_LONG_MS, retries: 1 },
    { file: 'test/skill-e2e-plan-prosons.test.ts', attemptMs: 4 * (CAPTURE_MS + 10_000), retries: 1 },
    // Gate: six 300s cases + one 610s case; periodic: two 900s + three 600s.
    { file: 'test/skill-e2e-plan.test.ts', attemptMs: Math.max(6 * CAPTURE_MS + CAPTURE_LONG_MS + 10_000, 2 * PTY_MS + 3 * CAPTURE_LONG_MS), retries: 1 },
  ].map(({ file, attemptMs, retries }) => ({
    file, attemptMs, retries,
    id: `${file.slice('test/'.length, -'.test.ts'.length)}-existing-retry-v1`,
    shardReserveMs: AUTOPLAN_CHAIN_BUDGET.shardReserveMs,
    shardMs: attemptMs * (retries + 1) + AUTOPLAN_CHAIN_BUDGET.shardReserveMs,
  })),
];

/** The only registered over-tier test budget; arbitrary per-file escapes fail. */
export function assertPaidTestBudget(file: string, ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0 ||
      (ms > PTY_LONG_MS * 1.25 &&
       (file !== AUTOPLAN_CHAIN_BUDGET.file || ms !== AUTOPLAN_CHAIN_BUDGET.testMs))) {
    throw new Error(`Unregistered paid test budget: ${file}: ${ms}`);
  }
}
