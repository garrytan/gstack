/**
 * Plan-mode-info no-op regression (gate tier, paid).
 *
 * Asserts: when /plan-ceo-review is invoked WITHOUT the plan-mode distinctive
 * phrase in the system reminder, the plan-mode-info preamble section is a
 * no-op. The skill should proceed to its normal Step 0 flow with no
 * AskUserQuestion echoing or referencing the plan-mode reminder text.
 *
 * This guardrails the "outside plan mode, this block doesn't interfere"
 * case — a different coverage case from the per-skill in-plan-mode smokes.
 * If the plan-mode-info section ever starts misfiring for non-plan-mode
 * sessions, this test catches it.
 *
 * Cost: ~$0.50 per run. Gated: EVALS=1 EVALS_TIER=gate.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanModeSkillTest,
  PLAN_MODE_REMINDER,
} from './helpers/plan-mode-helpers';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-mode-info no-op outside plan mode (gate regression)', () => {
  test('no AskUserQuestion echoes the plan-mode reminder when absent', async () => {
    const result = await runPlanModeSkillTest({
      skillName: 'plan-ceo-review',
      firstAnswerSubstring: 'HOLD',
      omitPlanModeReminder: true,
      maxTurns: 3,
    });

    // Skill should still hit Step 0 normally outside plan mode.
    expect(result.askUserQuestions.length).toBeGreaterThanOrEqual(1);

    // No AskUserQuestion should echo the plan-mode distinctive phrase.
    // If one does, the plan-mode-info section is leaking outside plan mode.
    for (const aq of result.askUserQuestions) {
      const questions = aq.input.questions as Array<{ question: string }>;
      for (const q of questions) {
        expect(q.question).not.toContain(PLAN_MODE_REMINDER);
      }
    }
  }, 120_000);
});
