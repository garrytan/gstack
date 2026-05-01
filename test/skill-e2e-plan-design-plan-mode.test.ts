/**
 * plan-design-review plan-mode smoke (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. Exercises the same contract against /plan-design-review.
 *
 * Note: on no-UI-scope branches plan-design-review legitimately short-
 * circuits to plan_ready without firing AskUserQuestion. Both 'asked' and
 * 'plan_ready' are valid pass outcomes.
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation, planFileHasDecisionsSection } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-design-review plan-mode smoke (gate)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-design-review',
      inPlanMode: true,
      timeoutMs: 300_000,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `plan-design-review plan-mode smoke FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
  }, 360_000);

  // v1.21+ regression: see skill-e2e-plan-ceo-plan-mode.test.ts for the
  // contract. plan-design-review legitimately short-circuits on no-UI-scope
  // branches, so this case keeps the same ['asked', 'plan_ready'] envelope
  // as the baseline. The discriminating regression signals are
  // 'auto_decided' (AUTO_DECIDE preamble fired upstream) or any failure
  // outcome — both mean the user never saw a question they should have.
  test('does not silently auto-decide when --disallowedTools AskUserQuestion is set', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-design-review',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: 300_000,
    });

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `plan-design-review AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    // plan-design-review legitimately short-circuits to plan_ready on no-UI
    // branches. Allow plan_ready WITHOUT a decisions section ONLY if the
    // plan file genuinely has no UI scope (we don't have a deterministic way
    // to check this from the test, so this skill keeps the looser envelope).
    // Other plan-mode skills require the decisions section under
    // --disallowedTools; design is the special case.
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
  }, 360_000);
});
