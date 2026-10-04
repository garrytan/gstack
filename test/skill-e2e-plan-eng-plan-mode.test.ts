/**
 * plan-eng-review plan-mode smoke (periodic, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. This file exercises the same contract against /plan-eng-review.
 */

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { assertNoPlanFileDecisions, assertPlanModeWithEvidence, seededPlanTargeted } from './helpers/plan-mode-evidence';
import {
  runPlanSkillObservation,
  planFileHasDecisionsSection,
  assertReportAtBottomIfPlanWritten,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

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

/**
 * The seeded plan proposes a custom test runner, so its Step 0 "what already
 * exists" pass reads the working tree's test setup. Run it in a small project
 * of its own, never the gstack checkout: there the agent explored gstack's own
 * sharded runner, and the review's length tracked unrelated runner edits
 * (a 300 s timeout in census 37228573062 after a runner refactor).
 */
function createRunnerPlanFixture(): { cwd: string; cleanup(): void } {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-eng-smoke-')));
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'tiny-math', private: true, type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n',
    'README.md': '# tiny-math\n\nA small Bun library. `bun test` runs the unit tests in test/.\n',
    'src/sum.ts': 'export function sum(values: number[]): number {\n  return values.reduce((total, value) => total + value, 0);\n}\n',
    'test/sum.test.ts': "import { expect, test } from 'bun:test';\nimport { sum } from '../src/sum';\n\ntest('sums values', () => {\n  expect(sum([1, 2, 3])).toBe(6);\n});\n",
  };
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
      fs.writeFileSync(path.join(cwd, name), content);
    }
    for (const args of [
      ['init', '-b', 'main'],
      ['add', '--', ...Object.keys(files)],
      ['-c', 'user.name=Plan Eng Fixture', '-c', 'user.email=plan-eng@example.test', '-c', 'commit.gpgsign=false',
        'commit', '--no-verify', '-m', 'Seed tiny-math'],
      ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
    ]) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
      if (result.error || result.status !== 0) throw new Error(`Could not initialize the plan-eng fixture: ${result.error?.message ?? result.stderr}`);
    }
    return { cwd, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Seed-only names; seeing one after the slash command shows the review read the seeded plan.
const SEED_PLAN_TOKENS = ['ShardManager', 'ResultMerger', 'test-shard-impl'];

describeE2E('plan-eng-review plan-mode smoke (periodic)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-eng-review',
      inPlanMode: true,
      timeoutMs: CAPTURE_MS,
    });

    assertPlanModeWithEvidence('plan-eng-review', 'reaches a terminal outcome (asked or plan_ready) without silent writes', obs, () => {
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
      assertNoPlanFileDecisions(obs, planFileHasDecisionsSection);
    });
  }, CAPTURE_LONG_MS);

  // D3-B / D4-B: when a plan with guaranteed-finding-triggering complexity
  // is seeded, the skill must ask (mcp AskUserQuestion or the prose fallback)
  // before writing findings to the plan. The wrote_findings_before_asking
  // outcome catches the transcript bug where the model writes findings to the
  // plan before any question renders. A plan-file ## Decisions section is not
  // a substitute for asking.
  test('STOP gate fires when seeded plan forces Step 0 findings', async () => {
    const fixture = createRunnerPlanFixture();
    let obs: Awaited<ReturnType<typeof runPlanSkillObservation>>;
    try {
      obs = await runPlanSkillObservation({
        skillName: 'plan-eng-review',
        inPlanMode: true,
        cwd: fixture.cwd,
        // As in auto-decide-preserved's standalone fixture: a first launch in a
        // fresh folder can paint a product notice under the composer, which
        // the plan-seed composer check (one footer row) never accepts.
        env: { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        initialPlanContent: SEED_PLAN_FORCING_FINDINGS,
        // Force the Conductor-style path: native AUQ disallowed → the model
        // must use mcp__*__AskUserQuestion or render the prose fallback
        // (both observed as outcome='asked').
        extraArgs: ['--disallowedTools', 'AskUserQuestion'],
        trackTokens: SEED_PLAN_TOKENS,
        timeoutMs: CAPTURE_MS,
      });
    } finally {
      fixture.cleanup();
    }

    assertPlanModeWithEvidence('plan-eng-review', 'STOP gate fires when seeded plan forces Step 0 findings', obs, () => {
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

      assertReportAtBottomIfPlanWritten(obs);
      assertNoPlanFileDecisions(obs, planFileHasDecisionsSection);
      if (obs.outcome !== 'asked') {
        throw new Error(
          `STOP-gate regression: outcome=${obs.outcome} — the seeded findings reached ` +
            `${obs.planFile ?? 'plan_ready'} without a question.\n` +
            `--- evidence (last 2KB) ---\n${obs.evidence}`,
        );
      }

      // Plan-mode scope-gate bypass: with a seeded plan in plan mode, the gate
      // must NOT render its "What should I review?" menu, and the review must
      // target the seeded plan. The announcement's exact wording is not graded.
      // Unseeded test 1 keeps its lenient contract: with no plan drafted, the
      // "ask as normal" fallback legitimately renders the question.
      expect(obs.scopeGateQuestionObserved ?? false).toBe(false);
      console.log(`[plan-eng plan-mode] scope announcement observed: ${obs.scopeGateAutoSelectObserved ?? false}; seed tokens: ${JSON.stringify(obs.tokensObserved ?? {})}`);
      expect(seededPlanTargeted(obs, SEED_PLAN_TOKENS), 'seeded plan was not targeted (scopeGateAutoSelectObserved or seed-only plan tokens)').toBe(true);
    });
  }, CAPTURE_LONG_MS);
});
