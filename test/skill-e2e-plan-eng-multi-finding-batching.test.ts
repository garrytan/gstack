/**
 * /plan-eng-review multi-finding batching regression (periodic, paid, real-PTY).
 *
 * Catches the specific shape of the May 2026 transcript bug that the
 * single-finding gate-tier floor test cannot detect: a model that fires
 * one AskUserQuestion and then batches the remaining findings into a
 * single "## Decisions to confirm" plan write + ExitPlanMode.
 *
 * Why a separate test from skill-e2e-plan-eng-finding-floor:
 *   - The gate-tier floor (runPlanSkillFloorCheck) exits on the first AUQ
 *     render and returns success. A model that fires once-then-batches
 *     would pass that test trivially.
 *   - This test uses runPlanSkillCounting at periodic tier (~25 min budget,
 *     N-AUQ tracking, ceiling-bounded retries) to actually count distinct
 *     review-phase AUQs and assert the model fires one per finding.
 *
 * Why a separate test from skill-e2e-plan-eng-finding-count (the existing
 * 5-finding count test):
 *   - The fixture here mirrors the D1-D4 transcript shape (4 findings) and
 *     the floor matches that exact threshold (3, the [N-1] tolerance band).
 *     This is the tightest regression test for the original bug class —
 *     not a band-around-N test, but a "did the agent batch?" test.
 *
 * Tier: periodic (~25 min, ~$5/run). Sequential by default.
 */

import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  runPlanSkillCounting,
  engStep0Boundary,
} from './helpers/claude-pty-runner';
import { FORCING_BATCHING_ENG } from './fixtures/forcing-finding-seeds';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const N = 4;
const FLOOR = N - 1; // 3 — agent must fire at least one AUQ per non-batched finding

const PLAN_PATH = '/tmp/gstack-test-plan-eng-batching.md';

describeE2E('/plan-eng-review multi-finding batching regression (periodic)', () => {
  test(
    `4-finding plan emits >= ${FLOOR} review-phase AskUserQuestions (no batching)`,
    async () => {
      try {
        fs.rmSync(PLAN_PATH, { force: true });
      } catch {
        /* best-effort */
      }

      const obs = await runPlanSkillCounting({
        skillName: 'plan-eng-review',
        slashCommand: '/plan-eng-review',
        followUpPrompt: FORCING_BATCHING_ENG,
        isLastStep0AUQ: engStep0Boundary,
        reviewCountCeiling: N + 3, // hard cap above floor + tolerance
        cwd: process.cwd(),
        timeoutMs: 1_500_000, // 25 min
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });

      try {
        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `multi-finding batching test FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        if (obs.reviewCount < FLOOR) {
          throw new Error(
            `BATCHING REGRESSION: reviewCount=${obs.reviewCount} < FLOOR=${FLOOR}.\n` +
              `Agent surfaced fewer review-phase AUQs than findings — this is the\n` +
              `May 2026 transcript bug shape: model batched multiple findings into\n` +
              `a single plan write + ExitPlanMode instead of asking one per finding.\n` +
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
