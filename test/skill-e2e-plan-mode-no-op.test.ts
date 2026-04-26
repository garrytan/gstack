/**
 * Plan-mode-info no-op regression (gate tier, paid, real-PTY).
 *
 * Asserts: when /plan-ceo-review is invoked OUTSIDE plan mode (no
 * --permission-mode plan flag, no plan-mode reminder injected), the skill
 * still reaches a terminal outcome ('asked' or 'plan_ready'). This is the
 * negative coverage to the per-skill plan-mode smokes — if the
 * plan-mode-info preamble section ever starts misfiring for non-plan-mode
 * sessions (e.g., gating questions on a phrase that isn't there), this
 * test catches it.
 *
 * Why this matters: outside plan mode, claude doesn't render a native
 * confirmation UI. The skill must drive its own AskUserQuestion. Same
 * runner, same outcome contract — just `inPlanMode: false`.
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-mode-info no-op outside plan mode (gate regression)', () => {
  test('skill reaches a terminal outcome outside plan mode', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-ceo-review',
      inPlanMode: false,
      timeoutMs: 300_000,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `plan-mode no-op regression FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);

    // Negative regression: the rendered output must NOT echo the plan-mode
    // distinctive reminder phrase. If it does, the plan-mode preamble
    // section is leaking outside plan mode.
    const PLAN_MODE_REMINDER =
      'Plan mode is active. The user indicated that they do not want you to execute yet';
    expect(obs.evidence).not.toContain(PLAN_MODE_REMINDER);
  }, 360_000);
});
