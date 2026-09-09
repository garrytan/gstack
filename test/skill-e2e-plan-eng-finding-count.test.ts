/**
 * /plan-eng-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Same shape as skill-e2e-plan-ceo-finding-count: drives /plan-eng-review
 * against a 5-finding seeded plan and asserts review-phase AUQ count ∈ [N-1, N+2].
 * Plus D19: review report at bottom of produced plan file.
 *
 * Tier: periodic (~25 min, ~$5/run). Sequential by default per plan §D15.
 */

import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  engStep0Boundary,
  engSetupAUQ,
  engFirstReviewAUQ,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1; // 4
const CEILING = N + 2; // 7

// Native controls found separate cache-validity, tenant-key, and new-code
// coverage gaps when these surrounding contracts were omitted. The shared
// mutable state and missing legacy regression below remain deliberate defects.
const planEng5Findings = (planPath: string) => [
  `Please review this plan thoroughly. Write the full reviewed implementation plan, including its final ## GSTACK REVIEW REPORT section, to ${planPath} (use Edit/Write to that exact path).`,
  `The separate QA Test Plan artifact belongs at the skill-prescribed test-plan path; keep this requested deliverable as the full reviewed implementation plan.`,
  '',
  '# Plan: Multi-tenant Auth Refactor',
  '',
  '## Existing contracts retained',
  'The existing cache adapter keys entries by tenant ID, issuer, audience,',
  'and policy version. It evicts expired tokens and invalidates entries on',
  'logout, token revocation, or tenant suspension. AuthCache retains these',
  'unchanged validity and tenant-key rules; they do not serialize mutations.',
  'AuthCache is a service-facing facade over that same existing adapter,',
  'with one backing cache. The adapter, its invalidation hooks, and their',
  'existing tests remain in use unchanged.',
  'Unit and integration coverage is planned for the new components and their',
  'success/error paths. That coverage does not exercise legacyAuthFlow() or',
  'assert compatibility with its prior behavior.',
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

describeE2E('/plan-eng-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR}-${CEILING} review-phase AskUserQuestions`,
    async () => {
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-eng-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-eng.md');

      try {
        const obs = await runPlanSkillCounting({
          skillName: 'plan-eng-review',
          slashCommand: '/plan-eng-review',
          followUpPrompt: planEng5Findings(planPath),
          expectedPlanPath: planPath,
          isLastStep0AUQ: engStep0Boundary,
          isSetupAUQ: engSetupAUQ,
          isFirstReviewAUQ: engFirstReviewAUQ,
          reviewCountCeiling: CEILING + 1,
          timeoutMs: 1_500_000,
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

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
            `BAND FAIL (above ceiling): reviewCount=${obs.reviewCount} > CEILING=${CEILING}.\n` +
              `Captured observation:\n${JSON.stringify(obs, null, 2)}`,
          );
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
