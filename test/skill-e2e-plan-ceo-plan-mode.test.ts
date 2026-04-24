/**
 * plan-ceo-review plan-mode smoke test (gate tier, paid).
 *
 * Asserts: when /plan-ceo-review is invoked with the plan-mode distinctive
 * phrase in the system reminder, the skill goes STRAIGHT to its Step 0
 * scope-mode AskUserQuestion. Specifically:
 *   1. First AskUserQuestion is NOT the old vestigial handshake
 *      (A=exit-and-rerun / C=cancel).
 *   2. No Write or Edit tool fires before the first AskUserQuestion
 *      (catches silent plan-file-write bypass).
 *   3. ExitPlanMode does not fire before the first AskUserQuestion.
 *
 * Cost: ~$0.50–$1.00 per run. Gated: EVALS=1 EVALS_TIER=gate.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanModeSkillTest,
  assertNotHandshakeShape,
} from './helpers/plan-mode-helpers';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-ceo-review plan-mode smoke (gate)', () => {
  test('goes straight to scope-mode question, no handshake, no silent writes', async () => {
    const result = await runPlanModeSkillTest({
      skillName: 'plan-ceo-review',
      // Step 0 asks for review mode; HOLD is the cheapest, most-neutral answer.
      firstAnswerSubstring: 'HOLD',
    });

    expect(result.askUserQuestions.length).toBeGreaterThanOrEqual(1);
    assertNotHandshakeShape(result.askUserQuestions[0]!);
    expect(result.writeOrEditBeforeAsk).toBe(false);
    expect(result.exitPlanModeBeforeAsk).toBe(false);
  }, 120_000);
});
