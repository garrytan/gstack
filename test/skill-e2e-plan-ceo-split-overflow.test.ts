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
 * The existing semantic scope validator examines every acknowledged native
 * call, including candidate choices before mode selection. It keeps the
 * N-1 call floor and requires independent offered dispositions for all five
 * candidates. The review-phase counter reports progress, not target coverage.
 * Collection ends once all five native choices are acknowledged; the same
 * semantic validator then decides whether those choices satisfy the metric.
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

import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  ceoStep0Boundary,
} from './helpers/claude-pty-runner';
import { FORCING_SPLIT_OVERFLOW_CEO } from './fixtures/forcing-finding-seeds';
import { ceoSplitDecisionFingerprints, isCeoSplitCandidateCall, isCeoSplitCollectionComplete, pickCeoSplitCountQuestion } from './helpers/ceo-split-question-policy';
import { CEO_SCOPE_CANDIDATES } from './helpers/plan-review-cases';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1; // 4 — must fire at least one AUQ per non-dropped option

/** Plan-file target baked into the FORCING_SPLIT_OVERFLOW_CEO fixture prompt.
 *  Rewritten per-run to a mkdtemp path so concurrent runs (--retry,
 *  EVALS_JOBS>1, sibling worktrees) never share one /tmp artifact. */
const FIXTURE_PLAN_PATH = '/tmp/gstack-test-plan-ceo-split-overflow.md';

describeE2E('/plan-ceo-review split-overflow regression (periodic)', () => {
  test(
    `5-option scope decision emits >= ${FLOOR} review-phase AskUserQuestions (no dropping)`,
    async () => {
      const deadlineAt = Date.now() + 1_500_000;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-ceo-split-overflow-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-ceo-split-overflow.md');
      const followUpPrompt = FORCING_SPLIT_OVERFLOW_CEO.replaceAll(FIXTURE_PLAN_PATH, planPath);
      if (!followUpPrompt.includes(planPath)) {
        throw new Error(
          `fixture drift: FORCING_SPLIT_OVERFLOW_CEO no longer contains ${FIXTURE_PLAN_PATH} — update FIXTURE_PLAN_PATH`,
        );
      }

      try {
        const obs = await runPlanSkillCounting({
          skillName: 'plan-ceo-review',
          slashCommand: '/plan-ceo-review',
          followUpPrompt,
          permissionPlanPath: planPath,
          isLastStep0AUQ: ceoStep0Boundary,
          // Candidate choices can occur before mode selection. Only those
          // acknowledged menus satisfy the split metric; expansions do not.
          isReviewAUQ: isCeoSplitCandidateCall,
          isCollectionComplete: isCeoSplitCollectionComplete,
          pickAUQ: pickCeoSplitCountQuestion,
          observeSetupQuestions: true,
          reviewCountCeiling: N + 3, // hard cap above floor + tolerance
          // The actor is configured for review; setup preferences are not scope choices.
          preconfiguredReviewActor: true,
          timeoutMs: deadlineAt - Date.now(), // One 25-minute budget, including final validation.
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        if (!['plan_ready', 'completion_summary', 'collection_complete', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `split-overflow test FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        // The phase counter is progress, not target coverage. The existing scope
        // validator keeps FLOOR=4 and requires all five independent candidate
        // decisions, complete native evidence, and offered Include/Defer/Cut ACKs.
        await evaluatePlanReviewDecisions({ plan: followUpPrompt, targets: CEO_SCOPE_CANDIDATES,
          fingerprints: ceoSplitDecisionFingerprints(obs.transcript, obs.fingerprints),
          floor: FLOOR, kind: 'scope', deadlineAt });
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
