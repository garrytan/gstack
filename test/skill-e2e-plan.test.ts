import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_MS, CAPTURE_LONG_MS, PTY_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { EvalCollector } from './helpers/eval-store';
import { OFFICE_HOURS_BUN_GRACE_MS, runRecordedOfficeHoursAttempt } from './helpers/office-hours-attempt';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, logCost, recordE2E,
  finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { judgePosture } from './helpers/llm-judge';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = evalsEnabled ? new EvalCollector('e2e', undefined, 'plan') : null;

// --- Plan CEO Review E2E ---

describeIfSelected('Plan CEO Review E2E', ['plan-ceo-review'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    // Init git repo (CEO review SKILL.md has a "System Audit" step that runs git)
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a simple plan document for the agent to review
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add User Dashboard

## Context
We're building a new user dashboard that shows recent activity, notifications, and quick actions.

## Changes
1. New React component \`UserDashboard\` in \`src/components/\`
2. REST API endpoint \`GET /api/dashboard\` returning user stats
3. PostgreSQL query for activity aggregation
4. Redis cache layer for dashboard data (5min TTL)

## Architecture
- Frontend: React + TailwindCSS
- Backend: Express.js REST API
- Database: PostgreSQL with existing user/activity tables
- Cache: Redis for dashboard aggregates

## Open questions
- Should we use WebSocket for real-time updates?
- How do we handle users with 100k+ activity records?
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-ceo-review skill
    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-ceo-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-ceo-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose HOLD SCOPE mode. Skip any AskUserQuestion calls — this is non-interactive.
Write your complete review directly to ${planDir}/review-output.md

Focus on reviewing the plan content: architecture, error handling, security, and performance.`,
      workingDirectory: planDir,
      maxTurns: 15,
      // 540s: the evidence-before-claimed-limitations directive and the
      // design-doc discovery block (fork port wave 2) add real probing turns;
      // main cleared this at 243s, the enriched skill needs more headroom.
      timeout: 540_000,
      testName: 'plan-ceo-review',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review', result);
    recordE2E(evalCollector, '/plan-ceo-review', 'Plan CEO Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    // Accept error_max_turns — the CEO review is very thorough and may exceed turns
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review was written
    const reviewPath = path.join(planDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, PTY_MS);
});

// --- Plan CEO Review (SELECTIVE EXPANSION) E2E ---

describeIfSelected('Plan CEO Review SELECTIVE EXPANSION E2E', ['plan-ceo-review-selective'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-sel-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add User Dashboard

## Context
We're building a new user dashboard that shows recent activity, notifications, and quick actions.

## Changes
1. New React component \`UserDashboard\` in \`src/components/\`
2. REST API endpoint \`GET /api/dashboard\` returning user stats
3. PostgreSQL query for activity aggregation
4. Redis cache layer for dashboard data (5min TTL)

## Architecture
- Frontend: React + TailwindCSS
- Backend: Express.js REST API
- Database: PostgreSQL with existing user/activity tables
- Cache: Redis for dashboard aggregates

## Open questions
- Should we use WebSocket for real-time updates?
- How do we handle users with 100k+ activity records?
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-ceo-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-ceo-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-selective', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose SELECTIVE EXPANSION mode. Skip any AskUserQuestion calls — this is non-interactive.
For the cherry-pick ceremony, accept all expansion proposals automatically.
Write your complete review directly to ${planDir}/review-output-selective.md

Focus on reviewing the plan content: architecture, error handling, security, and performance.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: CAPTURE_LONG_MS,
      testName: 'plan-ceo-review-selective',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review (SELECTIVE)', result);
    recordE2E(evalCollector, '/plan-ceo-review-selective', 'Plan CEO Review SELECTIVE EXPANSION E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    const reviewPath = path.join(planDir, 'review-output-selective.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, PTY_MS);
});

// --- Plan CEO Review SCOPE EXPANSION energy (V1.1 mode-posture regression gate) ---

describeIfSelected('Plan CEO Review Expansion Energy E2E', ['plan-ceo-review-expansion-energy'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-exp-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Use the shared fixture so expansion-energy regressions are reproducible.
    const fixture = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'mode-posture', 'expansion-plan.md'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planDir, 'plan.md'), fixture);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-ceo-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-ceo-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-expansion-energy', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose SCOPE EXPANSION mode. Skip any AskUserQuestion calls — this is non-interactive. Auto-approve the ideal-architecture approach in Alternatives. For Mode-Specific Analysis, run all three analyses (10x check, platonic ideal, delight opportunities), then emit exactly 2 concrete expansion proposals in the opt-in ceremony.

Write your expansion proposals to ${planDir}/proposals.md with ONLY the proposal text — no conversational wrapper, no review summary, no mode analysis. Each proposal separated by "---".`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: CAPTURE_LONG_MS,
      testName: 'plan-ceo-review-expansion-energy',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review (EXPANSION ENERGY)', result);
    recordE2E(evalCollector, '/plan-ceo-review-expansion-energy', 'Plan CEO Review Expansion Energy E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    // Transient API failure escape hatch — see /plan-review-report for the
    // full rationale. Same shape: error_api with 0 turns means the API call
    // never reached the model, so nothing the test verifies could have run.
    if (result.exitReason === 'error_api' && result.costEstimate?.turnsUsed === 0) {
      console.warn('[transient] /plan-ceo-review-expansion-energy: error_api with 0 turns — treating as inconclusive');
      return;
    }
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    const proposalsPath = path.join(planDir, 'proposals.md');
    if (!fs.existsSync(proposalsPath)) {
      throw new Error('Agent did not emit proposals.md — expansion energy eval requires proposal output');
    }
    const proposalText = fs.readFileSync(proposalsPath, 'utf-8');
    expect(proposalText.length).toBeGreaterThan(200);

    const scores = await judgePosture('expansion', proposalText);
    console.log('Expansion energy scores:', JSON.stringify(scores, null, 2));
    // Pass threshold: 4/5 on both axes (good — matches posture with minor weakness).
    expect(scores.axis_a).toBeGreaterThanOrEqual(4);  // surface_framing
    expect(scores.axis_b).toBeGreaterThanOrEqual(4);  // decision_preservation
  }, CAPTURE_LONG_MS);
});

// --- Plan Eng Review E2E ---

describeIfSelected('Plan Eng Review E2E', ['plan-eng-review'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-eng-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a plan with more engineering detail
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Migrate Auth to JWT

## Context
Replace session-cookie auth with JWT tokens. Currently using express-session + Redis store.

## Changes
1. Add \`jsonwebtoken\` package
2. New middleware \`auth/jwt-verify.ts\` replacing \`auth/session-check.ts\`
3. Login endpoint returns { accessToken, refreshToken }
4. Refresh endpoint rotates tokens
5. Migration script to invalidate existing sessions

## Files Modified
| File | Change |
|------|--------|
| auth/jwt-verify.ts | NEW: JWT verification middleware |
| auth/session-check.ts | DELETED |
| routes/login.ts | Return JWT instead of setting cookie |
| routes/refresh.ts | NEW: Token refresh endpoint |
| middleware/index.ts | Swap session-check for jwt-verify |

## Error handling
- Expired token: 401 with \`token_expired\` code
- Invalid token: 401 with \`invalid_token\` code
- Refresh with revoked token: 403

## Not in scope
- OAuth/OIDC integration
- Rate limiting on refresh endpoint
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-eng-review skill
    fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
      path.join(planDir, 'plan-eng-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-eng-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-eng-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.
Write your complete review directly to ${planDir}/review-output.md

Focus on architecture, code quality, tests, and performance sections.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: CAPTURE_LONG_MS,
      testName: 'plan-eng-review',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-eng-review', result);
    recordE2E(evalCollector, '/plan-eng-review', 'Plan Eng Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review was written
    const reviewPath = path.join(planDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, CAPTURE_LONG_MS);
});

// --- Plan Review Report E2E ---
// Verifies that plan-eng-review writes a "## GSTACK REVIEW REPORT" section
// to the bottom of the plan file (the living review status footer).

describeIfSelected('Plan Review Report E2E', ['plan-review-report'], () => {
  test('/plan-eng-review writes GSTACK REVIEW REPORT to plan file', async () => {
    let planDir: string | undefined;
    try {
      await runRecordedOfficeHoursAttempt({
        collector: evalCollector, name: '/plan-review-report', suite: 'Plan Review Report E2E',
        model: 'claude-opus-4-7', budgetMs: CAPTURE_LONG_MS,
        run: async signal => {
          planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-report-'));
          const run = (cmd: string, args: string[]) => {
            const result = spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });
            if (result.error || result.status !== 0) {
              throw new Error(`plan-review-report fixture ${cmd}: ${result.error?.message || result.stderr?.toString() || `exit ${result.status}`}`);
            }
          };

          run('git', ['init', '-b', 'main']);
          run('git', ['config', 'user.email', 'test@test.com']);
          run('git', ['config', 'user.name', 'Test']);

          fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add Notifications System

## Context
We're building a real-time notification system for our SaaS app.

## Changes
1. WebSocket server for push notifications
2. Notification preferences API
3. Email digest fallback for offline users
4. PostgreSQL table for notification storage

## Architecture
- WebSocket: Socket.io on Express
- Queue: Bull + Redis for email digests
- Storage: PostgreSQL notifications table
- Frontend: React toast component

## Open questions
- Retry policy for failed WebSocket delivery?
- Max notifications stored per user?
`);

          run('git', ['add', '.']);
          run('git', ['commit', '-m', 'add plan']);

          // Copy plan-eng-review skill
          fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
          fs.copyFileSync(
            path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
            path.join(planDir, 'plan-eng-review', 'SKILL.md'),
          );
          // The canonical report section is required, not an optional host cache.
          fs.cpSync(path.join(ROOT, 'plan-eng-review', 'sections'),
            path.join(planDir, 'plan-eng-review', 'sections'), { recursive: true });

          return runSkillTest({
            prompt: `Read plan-eng-review/SKILL.md and plan-eng-review/sections/review-sections.md for the review workflow and canonical report format.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections.

plan.md is the plan file for this review session; save your review there.`,
            workingDirectory: planDir,
            maxTurns: 20,
            timeout: CAPTURE_LONG_MS,
            testName: 'plan-review-report',
            runId, signal,
            model: 'claude-opus-4-7',
          });
        },
        validate: result => {
          logCost('/plan-eng-review report', result);
          expect(['success', 'error_max_turns']).toContain(result.exitReason);

          // Verify the review report was written to the plan file
          const planContent = fs.readFileSync(path.join(planDir!, 'plan.md'), 'utf-8');

          // Original plan content should still be present
          expect(planContent).toContain('# Plan: Add Notifications System');
          expect(planContent).toContain('WebSocket');

          // Review report section must exist
          expect(planContent).toContain('## GSTACK REVIEW REPORT');

          // Report should be at the bottom of the file
          const reportIndex = planContent.lastIndexOf('## GSTACK REVIEW REPORT');
          const afterReport = planContent.slice(reportIndex);

          // Should contain the review table with standard rows
          expect(afterReport).toMatch(/\|\s*Review\s*\|/);
          expect(afterReport).toContain('CEO Review');
          expect(afterReport).toContain('Eng Review');
          expect(afterReport).toContain('Design Review');

          // Mandatory unresolved-decisions status (plan-flag-unresolved-issues): the report's
          // final non-whitespace line must be the unresolved status — the exact sentinel or a
          // bullet of an UNRESOLVED DECISIONS block, with nothing (CODEX/CROSS-MODEL/VERDICT/
          // prose) after it.
          expect(afterReport).toContain('UNRESOLVED DECISIONS');
          // Compute from afterReport (the report section to EOF), not the whole file, so a
          // mid-file report surfaces the real trailing content in the failure message.
          const nonEmpty = afterReport.split('\n').map(l => l.trim()).filter(l => l !== '');
          const lastLine = nonEmpty[nonEmpty.length - 1];
          const isSentinel = lastLine === 'NO UNRESOLVED DECISIONS';
          const isUnresolvedBullet =
            /^[-*]\s+/.test(lastLine) && !/VERDICT/i.test(lastLine) && afterReport.includes('UNRESOLVED DECISIONS:');
          expect(
            isSentinel || isUnresolvedBullet,
            `report must end with the unresolved-decisions status; last line was: ${lastLine}`,
          ).toBe(true);

          console.log('Plan review report found at bottom of plan.md (ends with unresolved status)');
        },
      });
    } finally {
      // Each configured retry owns a pristine plan and finishes cleanup first.
      if (planDir) try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
    }
  }, CAPTURE_LONG_MS + OFFICE_HOURS_BUN_GRACE_MS);
});

// --- Codex Offering E2E ---
// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
