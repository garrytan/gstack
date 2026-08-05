/**
 * AskUserQuestion unavailable → prose decision brief (periodic, paid, real PTY).
 *
 * Proves the end-to-end fallback: when no AskUserQuestion tool can be called, a
 * skill that reaches a decision renders a prose brief and waits instead of
 * silently skipping the user.
 *
 * This harness intentionally does not set any Conductor environment variable or
 * register a host MCP variant. Conductor routing is covered deterministically by
 * question-preference-hook.test.ts; this test covers only the genuine
 * unavailable-tool fallback.
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

describeE2E('AskUserQuestion unavailable fallback (periodic)', () => {
  test('plan-eng-review surfaces a prose decision brief instead of silently skipping', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      // No host MCP is registered in the PTY harness; disable the native tool too.
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      initialPlanContent: FLAWED_PLAN,
      timeoutMs: 300_000,
    });

    // The decision must reach the human as prose. 'silent_write' (wrote findings
    // to the plan without asking) is the precise failure we guard against.
    if (obs.outcome === 'silent_write') {
      throw new Error(
        `Unavailable-tool fallback regression: skill wrote findings without surfacing a decision.\n` +
          `summary: ${obs.summary}\n--- evidence ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `Unavailable-tool fallback test inconclusive: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n--- evidence ---\n${obs.evidence}`,
      );
    }
    // A prose-rendered decision brief was observed at some point in the run.
    expect(obs.proseAUQEverObserved).toBe(true);
  }, 360_000);
});
