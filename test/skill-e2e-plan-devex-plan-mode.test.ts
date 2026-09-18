/**
 * plan-devex-review plan-mode smoke (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. Exercises the same contract against /plan-devex-review.
 */

import { test, expect } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  runPlanSkillObservation,
  planFileHasDecisionsSection,
  assertReportAtBottomIfPlanWritten,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('gate');

describeE2E('plan-devex-review plan-mode smoke (gate)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-devex-review',
      inPlanMode: true,
      timeoutMs: CAPTURE_MS,
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
    assertReportAtBottomIfPlanWritten(obs);
  }, CAPTURE_LONG_MS);

  // v1.21+ regression: see skill-e2e-plan-ceo-plan-mode.test.ts for the
  // contract. Pass envelope is ['asked', 'plan_ready']; failure signals
  // are 'auto_decided' (AUTO_DECIDE without opt-in) plus the standard
  // silent_write/exited/timeout.
  test('AskUserQuestion surfaces when --disallowedTools AskUserQuestion is set', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-devex-review',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: CAPTURE_MS,
    });

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `plan-devex-review AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'plan_ready') {
      if (!obs.planFile || !planFileHasDecisionsSection(obs.planFile)) {
        throw new Error(
          `plan-devex-review AskUserQuestion-blocked regression: plan_ready without a "## Decisions" section in ${obs.planFile ?? '<no plan file detected>'} — Step 0 was silently skipped.\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    assertReportAtBottomIfPlanWritten(obs);
  }, CAPTURE_LONG_MS);
});
