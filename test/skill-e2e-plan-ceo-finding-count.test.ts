/**
 * /plan-ceo-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Asserts the load-bearing rule "One issue = one AskUserQuestion call" by
 * driving /plan-ceo-review against a 5-finding seeded plan and counting
 * distinct review-phase AUQs. Passes when count is in [N-1, N+2].
 *
 * Two tests in this file:
 *   - 5-finding distinct fixture: count band assertion + D19 review-report-at-bottom.
 *   - 2-finding paired control (D12 positive control): related findings still
 *     produce 2 distinct AUQs, not 1 batched, when the rule is honored.
 *
 * Tier: periodic. Each run drives Step 0 + 11 review sections end-to-end
 * (~25 min, ~$5/run). Sequential by default per plan §D15. See
 * test/helpers/claude-pty-runner.ts for runPlanSkillCounting internals.
 */

import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  runPlanSkillCounting,
  ceoStep0Boundary,
  assertReviewReportAtBottom,
  type AskUserQuestionFingerprint,
} from './helpers/claude-pty-runner';

/**
 * /plan-ceo-review's first AUQ asks "what scope?" with options like
 *   1. Branch diff vs main
 *   2. A specific plan file or design doc
 *   3. An idea you'll describe inline
 *   ...
 *   7. Skip interview and plan immediately
 *
 * The default pick (1) routes to "branch diff vs main" — the wrong target
 * for our seeded fixture (the agent would review the gstack PR itself,
 * recursively). Picking "Skip interview and plan immediately" bypasses
 * Step 0 and routes the agent to review the chat context (where our
 * follow-up plan was pasted).
 */
function pickSkipInterview(fp: AskUserQuestionFingerprint): number {
  const skipOpt = fp.options.find((o) =>
    /skip\s+interview|plan\s+immediately/i.test(o.label),
  );
  if (skipOpt) return skipOpt.index;
  // Fallback: "describe inline" also routes to using our pasted plan.
  const inlineOpt = fp.options.find((o) =>
    /describe.*inline|inline.*idea/i.test(o.label),
  );
  if (inlineOpt) return inlineOpt.index;
  return 1;
}

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const N_DISTINCT = 5;
const FLOOR_DISTINCT = N_DISTINCT - 1; // 4 (D11)
const CEILING_DISTINCT = N_DISTINCT + 2; // 7 (D11)

const N_PAIRED = 2;
const FLOOR_PAIRED = 2;
const CEILING_PAIRED = 4;

const PLAN_CEO_5_FINDINGS = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-ceo.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Payment Processing Integration',
  '',
  '## Architecture',
  "We're adding a new `PaymentService` class that will handle Stripe webhooks.",
  'This bypasses the existing `WebhookDispatcher` module — we want a clean',
  'namespace separation.',
  '',
  '## Database access',
  'The new endpoint reads `request.params.userId` directly into a raw SQL',
  'fragment for the lookup query.',
  '',
  '## Webhook fan-out',
  'On payment success we update the user record AND fire a notification email.',
  'Both happen inline; no error handling on the email leg.',
  '',
  '## Tests',
  "None planned. We'll rely on the existing integration suite catching regressions.",
  '',
  '## Performance',
  'Each webhook lookup hits the database for the user, then fetches each',
  'order in a loop.',
].join('\n');

const PLAN_CEO_2_PAIRED_FINDINGS = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-ceo-paired.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Payment Processing — Test Coverage',
  '',
  '## Tests',
  'We need test coverage for `processPayment()`. Specifically:',
  '1. The happy path (successful Stripe charge — assert correct receipt is generated).',
  '2. The error/timeout path (Stripe returns 502 — assert retry-with-backoff fires once, then fails clean).',
  '',
  'Currently neither has a unit test. These are deliberately separate concerns:',
  'the success path is correctness, the failure path is graceful degradation.',
].join('\n');

const PLAN_CEO_PATH = '/tmp/gstack-test-plan-ceo.md';
const PLAN_CEO_PAIRED_PATH = '/tmp/gstack-test-plan-ceo-paired.md';

describeE2E('/plan-ceo-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR_DISTINCT}-${CEILING_DISTINCT} review-phase AskUserQuestions`,
    async () => {
      try {
        fs.rmSync(PLAN_CEO_PATH, { force: true });
      } catch {
        /* best-effort */
      }

      const obs = await runPlanSkillCounting({
        skillName: 'plan-ceo-review',
        slashCommand: '/plan-ceo-review',
        followUpPrompt: PLAN_CEO_5_FINDINGS,
        isLastStep0AUQ: ceoStep0Boundary,
        reviewCountCeiling: CEILING_DISTINCT + 1, // hard cap above assertion ceiling
        firstAUQPick: pickSkipInterview, // bypass scope-selection, route to review
        cwd: process.cwd(),
        timeoutMs: 1_500_000, // 25 min
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });

      try {
        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `plan-ceo-review finding-count FAILED: outcome=${obs.outcome}\n` +
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
        if (obs.reviewCount < FLOOR_DISTINCT) {
          throw new Error(
            `BAND FAIL (below floor): reviewCount=${obs.reviewCount} < FLOOR=${FLOOR_DISTINCT}.\n` +
              `Likely batching regression — agent collapsed multiple findings into fewer questions.\n` +
              `Fingerprints (review-phase only):\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n'),
          );
        }
        if (obs.reviewCount > CEILING_DISTINCT) {
          throw new Error(
            `BAND FAIL (above ceiling): reviewCount=${obs.reviewCount} > CEILING=${CEILING_DISTINCT}.\n` +
              `Possible over-asking regression. Review-phase fingerprints:\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n'),
          );
        }

        // D19: review report at bottom of plan file.
        if (!fs.existsSync(PLAN_CEO_PATH)) {
          throw new Error(
            `D19 FAIL: agent did not produce expected plan file at ${PLAN_CEO_PATH}.\n` +
              `Either the agent ignored the path instruction in the follow-up prompt, or\n` +
              `the helper exited before the agent wrote the file. ` +
              `outcome=${obs.outcome} review=${obs.reviewCount}`,
          );
        }
        const planContent = fs.readFileSync(PLAN_CEO_PATH, 'utf-8');
        const verdict = assertReviewReportAtBottom(planContent);
        if (!verdict.ok) {
          throw new Error(
            `D19 FAIL: plan file at ${PLAN_CEO_PATH} ${verdict.reason}\n` +
              (verdict.trailingHeadings
                ? `Trailing headings: ${verdict.trailingHeadings.join(' | ')}\n`
                : '') +
              `--- plan content (last 1KB) ---\n${planContent.slice(-1024)}`,
          );
        }
      } finally {
        try {
          fs.rmSync(PLAN_CEO_PATH, { force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_700_000,
  );

  test(
    `paired-finding positive control: ${N_PAIRED} related findings produce ${FLOOR_PAIRED}-${CEILING_PAIRED} AskUserQuestions`,
    async () => {
      try {
        fs.rmSync(PLAN_CEO_PAIRED_PATH, { force: true });
      } catch {
        /* best-effort */
      }

      const obs = await runPlanSkillCounting({
        skillName: 'plan-ceo-review',
        slashCommand: '/plan-ceo-review',
        followUpPrompt: PLAN_CEO_2_PAIRED_FINDINGS,
        isLastStep0AUQ: ceoStep0Boundary,
        reviewCountCeiling: CEILING_PAIRED + 1,
        cwd: process.cwd(),
        timeoutMs: 1_500_000,
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });

      try {
        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `paired-finding control FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount}\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        if (obs.reviewCount < FLOOR_PAIRED) {
          throw new Error(
            `PAIRED CONTROL FAIL: reviewCount=${obs.reviewCount} < FLOOR=${FLOOR_PAIRED}.\n` +
              `Two deliberately related findings were batched into <2 questions — the rule failed under D12.\n` +
              `Review-phase fingerprints:\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n'),
          );
        }
        if (obs.reviewCount > CEILING_PAIRED) {
          throw new Error(
            `PAIRED CONTROL FAIL: reviewCount=${obs.reviewCount} > CEILING=${CEILING_PAIRED} (over-asking on a 2-finding fixture).`,
          );
        }
      } finally {
        try {
          fs.rmSync(PLAN_CEO_PAIRED_PATH, { force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_700_000,
  );
});
