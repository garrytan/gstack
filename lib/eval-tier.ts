/**
 * Model tier selection for evals.
 *
 * Maps tier names to Claude models. Supports env var overrides
 * for EVAL_TIER and EVAL_JUDGE_TIER.
 */

export type EvalTier = 'fast' | 'standard' | 'full';

export const TIER_ALIASES: Record<string, EvalTier> = {
  haiku: 'fast',
  sonnet: 'standard',
  opus: 'full',
};

const TIER_TO_MODEL: Record<EvalTier, string> = {
  fast: 'claude-haiku-4-5',
  standard: 'claude-sonnet-4-6',
  full: 'claude-opus-4-6',
};

/**
 * Resolve the eval tier from EVAL_TIER env var.
 * Supports both tier names ('fast', 'standard', 'full') and
 * model aliases ('haiku', 'sonnet', 'opus').
 * Defaults to 'standard'.
 */
export function resolveTier(): EvalTier {
  const raw = process.env.EVAL_TIER?.toLowerCase().trim();
  if (!raw) return 'standard';
  if (raw in TIER_ALIASES) return TIER_ALIASES[raw];
  if (raw === 'fast' || raw === 'standard' || raw === 'full') return raw;
  return 'standard';
}

/**
 * Resolve the judge tier from EVAL_JUDGE_TIER env var.
 * Falls back to resolveTier() if not set.
 */
export function resolveJudgeTier(): EvalTier {
  const raw = process.env.EVAL_JUDGE_TIER?.toLowerCase().trim();
  if (!raw) return resolveTier();
  if (raw in TIER_ALIASES) return TIER_ALIASES[raw];
  if (raw === 'fast' || raw === 'standard' || raw === 'full') return raw;
  return resolveTier();
}

/** Map a tier to its Claude model ID. */
export function tierToModel(tier: EvalTier): string {
  return TIER_TO_MODEL[tier];
}
