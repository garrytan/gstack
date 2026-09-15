/**
 * plan-design-review plan-mode smoke (periodic, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. Exercises the same contract against /plan-design-review.
 *
 * Note: on no-UI-scope branches plan-design-review legitimately short-
 * circuits to plan_ready without firing AskUserQuestion. Both 'asked' and
 * 'plan_ready' are valid pass outcomes.
 */

import { test, expect } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  runPlanSkillObservation,
  assertReportAtBottomIfPlanWritten,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

// UI-heavy seed with guaranteed design gaps (center-aligned everything, no
// empty states, no responsive intent) so the review has real findings to
// surface. Inline twin of the eng smoke's SEED_PLAN_FORCING_FINDINGS —
// FORCING_FLOOR_DESIGN from forcing-finding-seeds.ts is NOT reusable here:
// it embeds a write-to-/tmp instruction shaped for the floor check's
// followUpPrompt, which would trip strictPlanWrites as a silent_write.
const SEED_PLAN_UI_HEAVY = `
# Plan: Marketing landing page

## Layout
All headings, taglines, and body copy will be center-aligned for a
"clean modern look." The hero h1 sits 8px above the subhead; the CTA
button has the same visual weight as the "Learn more" link beside it.

## Pages
- / (hero, 3-column features grid, testimonials carousel, footer)
- /pricing (3 tier cards)

## States
Only the happy path is designed. No empty states, no error states,
no loading states. Mobile: "stacks on mobile."
`;

describeE2E('plan-design-review plan-mode smoke (periodic)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-design-review',
      inPlanMode: true,
      timeoutMs: CAPTURE_MS,
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
    assertReportAtBottomIfPlanWritten(obs);
  }, CAPTURE_LONG_MS);

  // Plan-mode scope-gate bypass: with a seeded UI-heavy plan in plan mode,
  // the gate must NOT render its "What should I review?" menu — it
  // auto-selects B and announces it, then proceeds to the pre-review audit
  // and mockups. Mirrors the eng smoke's seeded STOP-gate test, without
  // --disallowedTools (native AUQ available is the common path here).
  test('scope gate auto-selects B when a plan is seeded in plan mode', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-design-review',
      inPlanMode: true,
      initialPlanContent: SEED_PLAN_UI_HEAVY,
      timeoutMs: CAPTURE_MS,
    });

    if (
      obs.outcome === 'wrote_findings_before_asking' ||
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `plan-design plan-mode bypass FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\nelapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB) ---\n${obs.evidence}`,
      );
    }

    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    assertReportAtBottomIfPlanWritten(obs);

    // The bypass contract (exception ordering makes this deterministic even
    // though the seed arrives as a pasted user message).
    expect(obs.scopeGateQuestionObserved ?? false).toBe(false);
    expect(obs.scopeGateAutoSelectObserved ?? false).toBe(true);
  }, CAPTURE_LONG_MS);
});
