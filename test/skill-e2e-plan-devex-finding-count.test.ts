/**
 * /plan-devex-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Same shape as skill-e2e-plan-ceo-finding-count: drives /plan-devex-review
 * against a seeded plan and requires a distinct completed decision for each known gap.
 * Additional real findings and deferred TODO decisions remain valid work.
 * DevEx deliberately resolves friction during Step 0, before scoring passes;
 * count those decisions too, while excluding administrative confirmations.
 * Plus D19: review report at bottom of produced plan file.
 *
 * Tier: periodic (~25 min, ~$5/run). Sequential by default per plan §D15.
 */

import { test } from 'bun:test';
import { devexSeedCoverage } from './helpers/devex-seed-coverage';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  devexStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';
import {
  DEVEX_COUNT_FILES,
  planDevexCountFixture,
  isDevexReviewIssue,
  devexReviewModePick,
} from './helpers/devex-count-fixture';

const describeE2E = describeE2ETier('periodic');

describeE2E('/plan-devex-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    'all five seeded gaps receive distinct decisions and a final review report',
    async () => {
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-devex-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-devex.md');

      try {
        const obs = await runPlanSkillCounting({
          skillName: 'plan-devex-review',
          slashCommand: '/plan-devex-review',
          followUpPrompt: planDevexCountFixture(planPath) + '\nFinish this DX review; I will handle subsequent reviews manually.',
          expectedPlanPath: planPath,
          fixtureFiles: DEVEX_COUNT_FILES,
          isLastStep0AUQ: devexStep0Boundary,
          isReviewAUQ: isDevexReviewIssue,
          pickAUQ: devexReviewModePick,
          // Valid additional findings are bounded by the existing wall deadline.
          reviewCountCeiling: Infinity,
          timeoutMs: 1_500_000,
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        if (!['plan_ready', 'completion_summary'].includes(obs.outcome)) {
          throw new Error(
            `plan-devex-review finding-count FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `fingerprints (last 8):\n` +
              obs.fingerprints
                .slice(-8)
                .map(
                  (f, i) =>
                    `  ${i}. preReview=${f.preReview} sig=${f.signature.slice(0, 12)} prompt="${f.promptSnippet.slice(0, 60)}"`,
                )
                .join('\n') +
              `\n--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        const coverage = devexSeedCoverage(obs.transcript);
        if (!coverage.complete) {
          throw new Error(`SEEDED COVERAGE FAIL: ${JSON.stringify(coverage)}\n` +
            `legacy diagnostic reviewCount=${obs.reviewCount}; outcome=${obs.outcome}`);
        }

        if (!fs.existsSync(planPath)) {
          throw new Error(
            `D19 FAIL: agent did not produce expected plan file at ${planPath}. ` +
              `outcome=${obs.outcome} review=${obs.reviewCount}`,
          );
        }
        const planContent = fs.readFileSync(planPath, 'utf-8');
        const verdict = assertReviewReportAtBottom(planContent);
        if (!verdict.ok) {
          throw new Error(
            `D19 FAIL: plan file at ${planPath} ${verdict.reason}\n` +
              (verdict.trailingHeadings
                ? `Trailing headings: ${verdict.trailingHeadings.join(' | ')}\n`
                : '') +
              `--- plan content (last 1KB) ---\n${planContent.slice(-1024)}`,
          );
        }
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_500_000 /* physical ceiling: the 25-min CI job + 1800s shard wall cap what can actually execute */,
  );
});
