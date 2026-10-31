/**
 * The blocking floor every gstack reviewer prompt carries (docs/review-policy.md#the-blocking-floor).
 * One sentence, so the core checklist, each specialist and the fix-check rate severity the
 * same way. It extends lib/review-scope.ts's floor words (the prose voices' copy) with the
 * security clause. test/review-severity-floor.test.ts keeps the markdown copies in step.
 */
import { BLOCKING_FLOOR as FLOOR_WORDS } from '../../lib/review-scope';

export const BLOCKING_FLOOR = `CRITICAL is the blocking floor: a finding that ${FLOOR_WORDS}, or open a security hole (injection, auth bypass, secret exposure). Everything else is INFORMATIONAL.`;
