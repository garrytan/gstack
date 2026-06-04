/**
 * /plan-ceo-review split-overflow regression (periodic, paid, real-PTY).
 *
 * Catches the original failure mode the user complained about: when the
 * agent has 5+ options for ONE conceptual decision, it must split into N
 * sequential AskUserQuestion calls (or batch into compatible ≤4-groups),
 * NOT drop an option arbitrarily to fit Conductor's 4-option cap.
 *
 * Pre-fix reasoning trace from the user transcript that motivated this:
 *   "I'm hitting Conductor's limit of 4 options in the AUQ, so I need
 *    to cut one. E4 is the largest lift and probably beyond scope...
 *    Trimming: E4. Moving to TODOs without asking. Re-firing with 4."
 *
 * The fixture seeds 5 independent scope candidates (chat-platform
 * integrations) — each carries an independent include/defer/cut decision.
 * With the split rule active, the natural compliant shape is a per-option
 * chain at parent D<N>; the test asserts the agent fires at least
 * [N-1] review-phase AUQs (standard tolerance band from the existing
 * finding-count tests, which accounts for one expected scope-reduction
 * call before the per-option chain begins).
 *
 * Why a separate test from skill-e2e-plan-ceo-finding-count and
 * skill-e2e-plan-eng-multi-finding-batching:
 *   - finding-count tests fire one AUQ per finding (Architecture, Code
 *     Quality, etc) — they exercise the "one issue per call" rule, not
 *     the "5+ options for ONE decision" split rule.
 *   - This test fixtures ONE scope decision with 5 options inside it,
 *     which is exactly the shape that hits Conductor's 4-option cap and
 *     triggers the new split-vs-drop guidance.
 *
 * Tier: periodic (~25 min, ~$0.30-$5.00/run depending on agent path).
 * Sequential by default.
 */

import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  runPlanSkillCounting,
  ceoStep0Boundary,
} from './helpers/claude-pty-runner';
import { FORCING_SPLIT_OVERFLOW_CEO } from './fixtures/forcing-finding-seeds';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const N = 5;
const FLOOR = N - 1; // 4 — must fire at least one AUQ per non-dropped option

const PLAN_PATH = '/tmp/gstack-test-plan-ceo-split-overflow.md';

describeE2E('/plan-ceo-review split-overflow regression (periodic)', () => {
  test(
    `5-option scope decision emits >= ${FLOOR} review-phase AskUserQuestions (no dropping)`,
    async () => {
      try {
        fs.rmSync(PLAN_PATH, { force: true });
      } catch {
        /* best-effort */
      }

      const obs = await runPlanSkillCounting({
        skillName: 'plan-ceo-review',
        slashCommand: '/plan-ceo-review',
        followUpPrompt: FORCING_SPLIT_OVERFLOW_CEO,
        isLastStep0AUQ: ceoStep0Boundary,
        reviewCountCeiling: N + 3, // hard cap above floor + tolerance
        cwd: process.cwd(),
        timeoutMs: 1_500_000, // 25 min
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });

      try {
        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `split-overflow test FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        if (obs.reviewCount < FLOOR) {
          throw new Error(
            `SPLIT-OVERFLOW REGRESSION: reviewCount=${obs.reviewCount} < FLOOR=${FLOOR}.\n` +
              `Agent surfaced fewer review-phase AUQs than independent scope options.\n` +
              `This is the original drop-to-fit-4-options failure mode:\n` +
              `  expected: ${N} per-option calls (or compliant ≤4-group batching with follow-up)\n` +
              `  got:      ${obs.reviewCount} call(s)\n` +
              `Most likely the agent dropped one option to fit Conductor's 4-option\n` +
              `cap, the exact bug scripts/resolvers/preamble/generate-ask-user-format.ts\n` +
              `"Handling 5+ options — split, never drop" exists to prevent.\n` +
              `Review-phase fingerprints:\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n') +
              `\n--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
      } finally {
        try {
          fs.rmSync(PLAN_PATH, { force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_700_000,
  );
});
