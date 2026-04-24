/**
 * plan-devex-review plan-mode smoke test (gate tier, paid).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. Exercises the same assertions against /plan-devex-review.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanModeSkillTest,
  assertNotHandshakeShape,
} from './helpers/plan-mode-helpers';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-devex-review plan-mode smoke (gate)', () => {
  test('goes straight to DX-mode question, no handshake, no silent writes', async () => {
    const result = await runPlanModeSkillTest({
      skillName: 'plan-devex-review',
      // Step 0 asks for DX review mode; TRIAGE is the lightest-weight mode.
      firstAnswerSubstring: 'TRIAGE',
    });

    expect(result.askUserQuestions.length).toBeGreaterThanOrEqual(1);
    assertNotHandshakeShape(result.askUserQuestions[0]!);
    expect(result.writeOrEditBeforeAsk).toBe(false);
    expect(result.exitPlanModeBeforeAsk).toBe(false);
  }, 120_000);
});
