/**
 * Marathon: a fresh /plan-eng-review, from startup through Test review, writes
 * its QA test-plan artifact (paid, real-PTY, non-blocking).
 *
 * The periodic checkpoint (skill-e2e-plan-eng-artifact.test.ts) resumes after
 * Scope Challenge and Sections 1-2; this case keeps the whole interactive path.
 * Budget: PTY_LONG_MS. Measured on Claude Code 2.1.284: one fresh run passed at
 * 498 s; census 37174266054 and a local run both spent 595 s on startup plus six
 * one-at-a-time Scope Challenge questions without reaching Test review.
 *
 * Replaces the composing `plan-eng-review-artifact` case in skill-e2e-plan.test.ts.
 * That case told a `claude -p` session to skip the preamble and questions and
 * "go straight to the review"; in runs 37151477069, 37158847998 and 37162480720
 * (and one local CI-image run) the model wrote the whole review into one file
 * without executing the workflow, so it measured composing, not the skill. A
 * full interactive run does write the artifact (37158847998's batching PTY run
 * wrote eng-review-test-plan-20261003-224617.md during Test review).
 *
 * This case drives the real interactive /plan-eng-review over the same
 * dashboard plan and sources, answers each question with its first option, and
 * stops once the artifact exists or the report completes. The requirement is
 * unchanged: exactly one new QA test plan under the run's own state root, about
 * the reviewed dashboard change.
 */

import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PTY_LONG_MS } from './helpers/eval-budgets';
import { DASHBOARD_PLAN, FIXTURE_PLAN_PATH, SOURCES } from './helpers/plan-eng-artifact-fixture';
import { describeE2ETier } from './helpers/e2e-gate';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, hasCompletePlanReport, runPlanSkillCounting } from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('marathon');

describeE2E('/plan-eng-review QA test-plan artifact, full workflow (marathon)', () => {
  test('a fresh interactive review reaches Test review and writes one QA test plan', async () => {
    const startedAt = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-eng-artifact-full-'));
    const planPath = path.join(tmpDir, 'gstack-test-plan-eng-artifact.md');
    try {
      const obs = await runPlanSkillCounting({
        skillName: 'plan-eng-review',
        slashCommand: '/plan-eng-review',
        followUpPrompt: DASHBOARD_PLAN.replaceAll(FIXTURE_PLAN_PATH, planPath),
        fixtureFiles: SOURCES,
        permissionPlanPath: planPath,
        isLastStep0AUQ: engStep0Boundary,
        isSetupAUQ: engSetupAUQ,
        isFirstReviewAUQ: engFirstReviewAUQ,
        // The artifact is the only verdict; stop once it exists or the report is complete.
        isCollectionComplete: (_transcript, _fingerprints, testPlans) =>
          testPlans.length > 0 || hasCompletePlanReport(planPath, startedAt, Date.now()),
        reviewCountCeiling: Infinity,
        preconfiguredReviewActor: true,
        timeoutMs: PTY_LONG_MS,
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });
      const plans = obs.engTestPlans;
      console.log(`plan-eng-review-artifact-full: outcome=${obs.outcome} elapsed=${obs.elapsedMs}ms review=${obs.reviewCount} test plans=${plans.map(plan => plan.file).join(', ') || 'none'}`);
      if (!['plan_ready', 'completion_summary', 'collection_complete'].includes(obs.outcome)) {
        throw new Error(`plan-eng-review-artifact-full: outcome=${obs.outcome} (${obs.summary})\n--- evidence ---\n${obs.evidence}`);
      }
      expect(plans, `expected one new eng-review test plan; outcome=${obs.outcome}`).toHaveLength(1);
      expect(/dashboard|fetchStats|\/api\/stats/i.test(plans[0]!.content), 'the test plan covers the reviewed dashboard change').toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, PTY_LONG_MS + 30_000);
});
