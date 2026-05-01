/**
 * /plan-devex-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Same shape as skill-e2e-plan-ceo-finding-count: drives /plan-devex-review
 * against a 5-finding seeded plan and asserts review-phase AUQ count ∈ [N-1, N+2].
 * Plus D19: review report at bottom of produced plan file.
 *
 * Tier: periodic (~25 min, ~$5/run). Sequential by default per plan §D15.
 */

import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  runPlanSkillCounting,
  devexStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const N = 5;
const FLOOR = N - 1;
const CEILING = N + 2;

const PLAN_DEVEX_5_FINDINGS = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-devex.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Public SDK Beta Launch',
  '',
  '## Persona',
  "The plan doesn't specify which developer persona is the target — we're",
  "shipping for \"everyone,\" which means we tune for nobody.",
  '',
  '## TTHW (time to hello world)',
  'Time-to-hello-world is not measured. No benchmark data referenced. We',
  "don't know if first-run takes 5 minutes or 50.",
  '',
  '## Friction Point',
  'First-run currently requires a 5-minute mandatory CI step before the',
  'developer can run their first eval. There is no way to skip it.',
  '',
  '## Magical Moment',
  'Getting-started flow has no delight beat. Pure documentation, no',
  'interactive demo, no "ah-ha" moment that makes the developer trust us.',
  '',
  '## Competitive Blind Spot',
  "The plan doesn't reference how peer SDKs (LangChain, Semantic Kernel,",
  'OpenAI) handle this DX surface. We may be reinventing worse versions',
  'of solved problems.',
].join('\n');

const PLAN_DEVEX_PATH = '/tmp/gstack-test-plan-devex.md';

describeE2E('/plan-devex-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR}-${CEILING} review-phase AskUserQuestions`,
    async () => {
      try {
        fs.rmSync(PLAN_DEVEX_PATH, { force: true });
      } catch {
        /* best-effort */
      }

      const obs = await runPlanSkillCounting({
        skillName: 'plan-devex-review',
        slashCommand: '/plan-devex-review',
        followUpPrompt: PLAN_DEVEX_5_FINDINGS,
        isLastStep0AUQ: devexStep0Boundary,
        reviewCountCeiling: CEILING + 1,
        cwd: process.cwd(),
        timeoutMs: 1_500_000,
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });

      try {
        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
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
        if (obs.reviewCount < FLOOR) {
          throw new Error(
            `BAND FAIL (below floor): reviewCount=${obs.reviewCount} < FLOOR=${FLOOR}.\n` +
              `Likely batching regression. Review-phase fingerprints:\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n'),
          );
        }
        if (obs.reviewCount > CEILING) {
          throw new Error(
            `BAND FAIL (above ceiling): reviewCount=${obs.reviewCount} > CEILING=${CEILING}.`,
          );
        }

        if (!fs.existsSync(PLAN_DEVEX_PATH)) {
          throw new Error(
            `D19 FAIL: agent did not produce expected plan file at ${PLAN_DEVEX_PATH}. ` +
              `outcome=${obs.outcome} review=${obs.reviewCount}`,
          );
        }
        const planContent = fs.readFileSync(PLAN_DEVEX_PATH, 'utf-8');
        const verdict = assertReviewReportAtBottom(planContent);
        if (!verdict.ok) {
          throw new Error(
            `D19 FAIL: plan file at ${PLAN_DEVEX_PATH} ${verdict.reason}\n` +
              (verdict.trailingHeadings
                ? `Trailing headings: ${verdict.trailingHeadings.join(' | ')}\n`
                : '') +
              `--- plan content (last 1KB) ---\n${planContent.slice(-1024)}`,
          );
        }
      } finally {
        try {
          fs.rmSync(PLAN_DEVEX_PATH, { force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_700_000,
  );
});
