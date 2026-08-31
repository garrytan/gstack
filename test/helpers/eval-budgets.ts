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
 * should be SPLIT, not budgeted past the wall.
 */
export const PTY_LONG_MS = 1_200_000;

export const ALL_TIERS = {
  JUDGE_MS,
  CAPTURE_MS,
  CAPTURE_LONG_MS,
  PTY_MS,
  PTY_LONG_MS,
} as const;
