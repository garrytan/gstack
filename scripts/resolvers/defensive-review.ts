/**
 * Shared framing for subagents that reason adversarially over the full diff
 * (the adversarial pass, the Red Team, the security specialist). Repos whose
 * test corpus is attack payloads otherwise get those passes refused. The text
 * lives in lib/review-prompts.ts, which the reviewer packets read too.
 */
export { DEFENSIVE_REVIEW_FRAMING, FIXTURE_SUMMARY_MODE } from '../../lib/review-prompts';
