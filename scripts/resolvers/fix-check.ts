/**
 * Fix-check prompt (docs/review-policy.md#transitions): the one reviewer /ship dispatches after a
 * step whose fixes do not earn a full pass. It reads the fixes, never the whole diff. The text lives
 * in lib/review-prompts.ts so the generated prose and the reviewer packet share it.
 */
export { FIX_CHECK_INSTRUCTIONS, renderFixCheckPrompt, type FixCheckInput } from '../../lib/review-prompts';
