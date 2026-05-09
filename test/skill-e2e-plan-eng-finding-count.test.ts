/**
 * /plan-eng-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Same shape as skill-e2e-plan-ceo-finding-count: drives /plan-eng-review
 * against a 5-finding seeded plan and asserts review-phase AUQ count ∈ [N-1, N+2].
 * Plus D19: review report at bottom of produced plan file.
 *
 * Tier: periodic (~25 min, ~$5/run). Sequential by default per plan §D15.
 */

import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  runPlanSkillCounting,
  engStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const N = 5;
const FLOOR = N - 1; // 4
const CEILING = N + 2; // 7

const PLAN_ENG_5_FINDINGS = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-eng.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Multi-tenant Auth Refactor',
  '',
  '## Architecture',
  'Two new services (`AuthBroker` and `SessionMint`) share a global mutable',
  '`AuthCache` instance via module-level export. Both services mutate it.',
  '',
  '## Code quality',
  'The `validateAndDispatch()` function is 60 lines with three nested',
  'try/catch blocks; each catch swallows a different error class.',
  '',
  '## Tests',
  'The existing `legacyAuthFlow()` will get rewritten as part of this work;',
  'no regression test for the prior behavior is planned.',
  '',
  '## Performance',
  'Token validation issues 5 sequential API calls to the IDP; they could be',
  'parallelized via Promise.all trivially (calls are independent).',
  '',
  '## Architecture (scope smell)',
  'This touches 12 files and introduces 4 new classes (TokenStore,',
  'SessionMint, AuthCache, RequestPolicy). Worth flagging the complexity check.',
].join('\n');

const PLAN_ENG_PATH = '/tmp/gstack-test-plan-eng.md';

describeE2E('/plan-eng-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR}-${CEILING} review-phase AskUserQuestions`,
    async () => {
      try {
        fs.rmSync(PLAN_ENG_PATH, { force: true });
      } catch {
        /* best-effort */
      }

      const obs = await runPlanSkillCounting({
        skillName: 'plan-eng-review',
        slashCommand: '/plan-eng-review',
        followUpPrompt: PLAN_ENG_5_FINDINGS,
        isLastStep0AUQ: engStep0Boundary,
        reviewCountCeiling: CEILING + 1,
        cwd: process.cwd(),
        timeoutMs: 1_500_000,
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });

      try {
        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `plan-eng-review finding-count FAILED: outcome=${obs.outcome}\n` +
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

        if (!fs.existsSync(PLAN_ENG_PATH)) {
          throw new Error(
            `D19 FAIL: agent did not produce expected plan file at ${PLAN_ENG_PATH}. ` +
              `outcome=${obs.outcome} review=${obs.reviewCount}`,
          );
        }
        const planContent = fs.readFileSync(PLAN_ENG_PATH, 'utf-8');
        const verdict = assertReviewReportAtBottom(planContent);
        if (!verdict.ok) {
          throw new Error(
            `D19 FAIL: plan file at ${PLAN_ENG_PATH} ${verdict.reason}\n` +
              (verdict.trailingHeadings
                ? `Trailing headings: ${verdict.trailingHeadings.join(' | ')}\n`
                : '') +
              `--- plan content (last 1KB) ---\n${planContent.slice(-1024)}`,
          );
        }
      } finally {
        try {
          fs.rmSync(PLAN_ENG_PATH, { force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_700_000,
  );
});
