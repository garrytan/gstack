/**
 * Conductor → prose decision brief (periodic-tier, paid, real-PTY).
 *
 * Proves the end-to-end behavior: when CONDUCTOR_SESSION is signalled, a skill
 * that hits a decision renders a PROSE decision brief and waits, instead of
 * silently skipping the user.
 *
 * SCOPE — read before trusting this as the Conductor guard. This is END-TO-END
 * BEHAVIOR coverage, NOT the discriminating Conductor guarantee:
 *   - The deterministic guard is test/question-preference-hook.test.ts
 *     ("Conductor prose redirect") — it sets process.env.CONDUCTOR_* and asserts
 *     the PreToolUse hook denies + redirects. That test CAN fail on unfixed code.
 *   - The PTY harness here cannot register `mcp__conductor__AskUserQuestion`, so
 *     it tests "native AUQ unavailable + Conductor signal → prose," NOT "the MCP
 *     variant exists and must not be called" (Codex #10). Under --disallowedTools
 *     a present-human interactive session already prose-falls-back, so this test
 *     is a smoke check that the Conductor path still produces a prose brief, not
 *     a proof that the Conductor signal (vs the generic fallback) drove it.
 *
 * Periodic tier: model-behavior, non-deterministic.
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const FLAWED_PLAN = `# Plan: add a "developer-friendly" pricing tier

## Goal
Increase developer adoption.

## Premise
No tests mentioned, no rollout plan, no auth check on the upgrade endpoint.
Adds a Stripe tier, a React pricing page, a Postgres entitlements table, and a
Redis cache. The team "feels like" it should be cheaper; no developer was asked.
`;

describeE2E('Conductor renders decisions as prose (periodic)', () => {
  test('plan-eng-review in a Conductor session surfaces a PROSE decision brief, not a silent skip', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      // Mimic Conductor: native AUQ disabled + the Conductor env signal present.
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      env: { CONDUCTOR_WORKSPACE_PATH: '/tmp/conductor-prose-e2e' },
      initialPlanContent: FLAWED_PLAN,
      timeoutMs: 300_000,
    });

    // The decision must reach the human as prose. 'silent_write' (wrote findings
    // to the plan without asking) is the precise failure we guard against.
    if (obs.outcome === 'silent_write') {
      throw new Error(
        `Conductor prose regression: skill wrote findings without surfacing a decision.\n` +
          `summary: ${obs.summary}\n--- evidence ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `Conductor prose test inconclusive: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n--- evidence ---\n${obs.evidence}`,
      );
    }
    // A prose-rendered decision brief was observed at some point in the run.
    expect(obs.proseAUQEverObserved).toBe(true);
  }, 360_000);
});
