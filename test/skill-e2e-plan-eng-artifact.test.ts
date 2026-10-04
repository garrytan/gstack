/**
 * /plan-eng-review writes its QA test-plan artifact when its live Test review
 * runs (periodic checkpoint, paid, real-PTY).
 *
 * Replaces the composing `plan-eng-review-artifact` case in skill-e2e-plan.test.ts.
 * That case told a `claude -p` session to skip the preamble and questions and
 * "go straight to the review"; in runs 37151477069, 37158847998 and 37162480720
 * (and one local CI-image run) the model wrote the whole review into one file
 * without executing the workflow, so it measured composing, not the skill. A
 * full interactive run does write the artifact (37158847998's batching PTY run
 * wrote eng-review-test-plan-20261003-224617.md during Test review).
 *
 * A fresh run spends its budget on startup and one-at-a-time Scope Challenge
 * questions (census 37174266054: six questions, timeout at 595 s, no Test
 * review). This checkpoint resumes the real interactive /plan-eng-review from
 * the record a real run saves: the plan, Scope Challenge result, Sections 1-2
 * dispositions and a Decision ledger rebuilt from that census run's six actual
 * native questions and answers. The live skill then runs Section 3, Test
 * review, answering each question with its first option, and the case stops
 * once the artifact exists or the report completes. The requirement is
 * unchanged: exactly one new QA test plan under the run's own state root, about
 * the reviewed dashboard change. The fresh start-to-finish path is the marathon
 * case in skill-e2e-plan-eng-artifact-full.test.ts.
 */

import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { DASHBOARD_PLAN, SOURCES } from './helpers/plan-eng-artifact-fixture';
import { engResumeProblems, engResumeReport, type EngResumeCall } from './helpers/plan-eng-resume';
import resume from './fixtures/plan-eng-artifact-resume-37174266054.json';
import { describeE2ETier } from './helpers/e2e-gate';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, hasCompletePlanReport, runPlanSkillCounting } from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

describeE2E('/plan-eng-review QA test-plan artifact (periodic)', () => {
  test('an interactive review writes one QA test plan about the reviewed change', async () => {
    const startedAt = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-eng-artifact-'));
    const planPath = path.join(tmpDir, 'gstack-test-plan-eng-artifact.md');
    const calls = resume.calls as EngResumeCall[];
    const plan = DASHBOARD_PLAN.slice(DASHBOARD_PLAN.indexOf('# Plan: Add Dashboard'));
    const report = engResumeReport(plan, calls);
    expect(engResumeProblems(report, calls)).toEqual([]);
    fs.writeFileSync(planPath, report);
    try {
      const obs = await runPlanSkillCounting({
        skillName: 'plan-eng-review',
        slashCommand: '/plan-eng-review',
        followUpPrompt: [
          'Proceed directly to the requested engineering review; skip the optional /office-hours prerequisite.',
          `Resume my /plan-eng-review of this plan. Its report file is ${planPath}: it holds the plan, the completed Scope Challenge (D1-D${calls.length} answered) and Sections 1-2 (Architecture, Code quality) with no open choices, plus the Decision ledger. Read it first, keep using it as the report file, and do not redo or re-ask those stages. Continue at Section 3, Test review, and carry the review on from there.`,
          '',
          plan,
        ].join('\n'),
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
        timeoutMs: CAPTURE_LONG_MS,
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });
      const plans = obs.engTestPlans;
      console.log(`plan-eng-review-artifact: outcome=${obs.outcome} elapsed=${obs.elapsedMs}ms review=${obs.reviewCount} test plans=${plans.map(plan => plan.file).join(', ') || 'none'}`);
      if (!['plan_ready', 'completion_summary', 'collection_complete'].includes(obs.outcome)) {
        throw new Error(`plan-eng-review-artifact: outcome=${obs.outcome} (${obs.summary})\n--- evidence ---\n${obs.evidence}`);
      }
      expect(plans, `expected one new eng-review test plan; outcome=${obs.outcome}`).toHaveLength(1);
      expect(/dashboard|fetchStats|\/api\/stats/i.test(plans[0]!.content), 'the test plan covers the reviewed dashboard change').toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, CAPTURE_LONG_MS + 30_000);
});
