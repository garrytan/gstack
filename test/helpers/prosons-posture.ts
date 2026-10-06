/**
 * plan-review-prosons-neutral-neg's posture detector. A question for a plan
 * with one dominant option must not dodge to "taste call"; a negated mention
 * ("a coverage call, not a taste call", "NOT a taste call") is the opposite
 * posture and is not a dodge. Replayed against census captures in
 * test/prosons-neutral-posture.test.ts.
 */
export const NEUTRAL_POSTURE_RE = /(?<!\bnot\s+(?:an?\s+)?)\btaste call/i;
