/**
 * plan-eng-review plan-mode smoke (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. This file exercises the same contract against /plan-eng-review.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanSkillObservation,
  planFileHasDecisionsSection,
  assertReportAtBottomIfPlanWritten,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

// SEED_PLAN_FORCING_FINDINGS: 8+ files + custom-vs-builtin smell forces the
// Step 0 complexity check to trigger. Passed via runPlanSkillObservation's
// initialPlanContent (D3-B) so the spawned `claude` actually sees it.
const SEED_PLAN_FORCING_FINDINGS = `
# Parallelize unit tests

## Plan
Build a custom test runner: scripts/test-parallel.ts, scripts/test-shard-impl.ts,
scripts/test-merge-results.ts, scripts/test-progress.ts, scripts/test-watch.ts,
scripts/test-coverage.ts, scripts/test-cli.ts, scripts/test-config.ts.

Add new TestRunner class, new ShardManager class, new ResultMerger class.

Ignore Bun's native --shard flag because we want full control.

## Files
- scripts/test-parallel.ts (new)
- scripts/test-shard-impl.ts (new)
- scripts/test-merge-results.ts (new)
- scripts/test-progress.ts (new)
- scripts/test-watch.ts (new)
- scripts/test-coverage.ts (new)
- scripts/test-cli.ts (new)
- scripts/test-config.ts (new)
- package.json (add scripts)

## Tests
None planned — will add later.
`;

describeE2E('plan-eng-review plan-mode smoke (gate)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      timeoutMs: 300_000,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `plan-eng-review plan-mode smoke FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    assertReportAtBottomIfPlanWritten(obs);
  }, 360_000);

  // D3-B / D4-B: when a plan with guaranteed-finding-triggering complexity
  // is seeded, the skill MUST fire AskUserQuestion (or fall back to a
  // Decisions section) before writing findings to the plan. The
  // wrote_findings_before_asking outcome catches the precise transcript bug
  // — model writes findings to the plan before any AUQ render.
  test('STOP gate fires when seeded plan forces Step 0 findings', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      initialPlanContent: SEED_PLAN_FORCING_FINDINGS,
      // Force the Conductor-style path: native AUQ disallowed → the model
      // must use mcp__*__AskUserQuestion (outcome='asked') or fall back to
      // writing Decisions ('plan_ready').
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: 300_000,
    });

    if (
      obs.outcome === 'wrote_findings_before_asking' ||
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `STOP-gate regression: outcome=${obs.outcome}\nsummary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB) ---\n${obs.evidence}`,
      );
    }

    if (obs.outcome === 'plan_ready') {
      if (!obs.planFile || !planFileHasDecisionsSection(obs.planFile)) {
        throw new Error(
          `STOP-gate regression: plan_ready without ## Decisions section in ` +
            `${obs.planFile ?? '<no plan file>'} — gate skipped after ToolSearch.\n` +
            `--- evidence (last 2KB) ---\n${obs.evidence}`,
        );
      }
    }

    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    assertReportAtBottomIfPlanWritten(obs);
  }, 360_000);
});
