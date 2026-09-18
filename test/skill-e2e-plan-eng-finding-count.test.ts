/**
 * /plan-eng-review seeded issue coverage (periodic, paid, real-PTY).
 *
 * Each of four seeded decisions needs its own completed native AskUserQuestion.
 * The fifth seed, legacy regression coverage, is auto-added by the skill and
 * needs affirmative final-plan or public-narration evidence, not another AUQ.
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

import { evaluateEngTerminalReview } from './helpers/eng-seeded-coverage';
import { createEngCountActor, engCountActorRequest } from './helpers/eng-count-question-policy';

const describeE2E = describeE2ETier('periodic');

// Native controls found separate cache-validity, tenant-key, and new-code
// coverage gaps when these surrounding contracts were omitted. The shared
// mutable state and missing legacy regression below remain deliberate defects.
const planEng5Findings = (planPath: string) => [
  'Proceed directly to the requested engineering review; skip the optional /office-hours prerequisite.',
  `Please review this plan thoroughly. Write the full reviewed implementation plan, including its final ## GSTACK REVIEW REPORT section, to ${planPath} (use Edit/Write to that exact path).`,
  `The separate QA Test Plan artifact belongs at the skill-prescribed test-plan path; keep this requested deliverable as the full reviewed implementation plan.`,
  '',
  '# Plan: Multi-tenant Auth Refactor',
  '',
  '## Context supplied by the plan author',
  'The goal is to reorganize existing tenant-auth orchestration without changing',
  'its product behavior. RequestPolicy groups the existing per-request access',
  'decision: given already-fetched claims and tenant/request context, it returns',
  'allow or deny under the existing access policy. AuthBroker.validateAndDispatch()',
  'calls it after validation and before dispatch. It adds no policy, network call,',
  'cache mutation or state. Its separate class boundary remains a proposal to review.',
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
  'This touches 12 files and introduces 5 new classes (AuthBroker, TokenStore,',
  'SessionMint, AuthCache, RequestPolicy). Worth flagging the complexity check.',
].join('\n');

describeE2E('/plan-eng-review seeded issue coverage (periodic)', () => {
  test(
    '5-finding plan receives distinct native decisions and a completed review report',
    async () => {
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-eng-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-eng.md');

      try {
        const startedAt = Date.now();
        const deadlineAt = startedAt + 1_500_000;
        const followUpPrompt = planEng5Findings(planPath);
        const actorRequest = engCountActorRequest(followUpPrompt);
        let terminalAssessed = false;
        const obs = await runPlanSkillCounting({
          skillName: 'plan-eng-review',
          slashCommand: '/plan-eng-review',
          followUpPrompt: actorRequest,
          preconfiguredReviewActor: true,
          expectedPlanPath: planPath,
          approveEngTestPlanEdits: true,
          isLastStep0AUQ: engStep0Boundary,
          isSetupAUQ: engSetupAUQ,
          isFirstReviewAUQ: engFirstReviewAUQ,
          // Phase labels are progress only. One owned terminal assessment sees
          // every complete native call and the published report together.
          evaluateTerminal: async input => {
            if (terminalAssessed) throw new Error('Eng terminal was assessed more than once');
            terminalAssessed = true;
            return evaluateEngTerminalReview(followUpPrompt, { ...input, deadlineAt: Math.min(input.deadlineAt, deadlineAt) });
          },
          observeSetupQuestions: true,
          requireNativePicker: true,
          pickAUQ: createEngCountActor(actorRequest),
          // Extra legitimate decisions are not a failure. The unchanged wall limit
          // bounds runaway reviews; coverage below uses scoped completed native calls.
          reviewCountCeiling: Infinity,
          timeoutMs: deadlineAt - Date.now(),
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        if (!['plan_ready', 'completion_summary'].includes(obs.outcome)) {
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
        // A native completion summary may finish without ExitPlanMode. Its
        // existing runner gate already requires the report after every answer.
        if (!terminalAssessed) {
          terminalAssessed = true;
          await evaluateEngTerminalReview(followUpPrompt, { transcript: obs.transcript, report: planContent,
            reportMtimeMs: fs.lstatSync(planPath).mtimeMs, startedAt, finishedAt: Date.now(), deadlineAt });
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
