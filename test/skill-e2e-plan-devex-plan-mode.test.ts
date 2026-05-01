/**
 * plan-devex-review plan-mode smoke (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. Exercises the same contract against /plan-devex-review.
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-devex-review plan-mode smoke (gate)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-devex-review',
      inPlanMode: true,
      timeoutMs: 300_000,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `plan-devex-review plan-mode smoke FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
  }, 360_000);

  // v1.21+ regression: see skill-e2e-plan-ceo-plan-mode.test.ts for the
  // contract. plan-devex-review's Step 0 always issues a persona-mode
  // AskUserQuestion before scoring, so 'asked' is the only pass when
  // AskUserQuestion is --disallowedTools.
  test('AskUserQuestion surfaces when --disallowedTools AskUserQuestion is set', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-devex-review',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: 300_000,
    });

    if (obs.outcome !== 'asked') {
      throw new Error(
        `plan-devex-review AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(obs.outcome).toEqual('asked');
  }, 360_000);
});
