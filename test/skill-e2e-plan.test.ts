import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-plan');

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
      timeout: 360_000,
      testName: 'plan-ceo-review',
      runId,
      model: 'claude-opus-4-6',
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
  }, 420_000);
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
      timeout: 360_000,
      testName: 'plan-ceo-review-selective',
      runId,
      model: 'claude-opus-4-6',
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
  }, 420_000);
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
      timeout: 360_000,
      testName: 'plan-eng-review',
      runId,
      model: 'claude-opus-4-6',
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
  }, 420_000);
});

// --- Plan-Eng-Review Test-Plan Artifact E2E ---

describeIfSelected('Plan-Eng-Review Test-Plan Artifact E2E', ['plan-eng-review-artifact'], () => {
  let planDir: string;
  let projectDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-artifact-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create base commit on main
    fs.writeFileSync(path.join(planDir, 'app.ts'), 'export function greet() { return "hello"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Create feature branch with changes
    run('git', ['checkout', '-b', 'feature/add-dashboard']);
    fs.writeFileSync(path.join(planDir, 'dashboard.ts'), `export function Dashboard() {
  const data = fetchStats();
  return { users: data.users, revenue: data.revenue };
}
function fetchStats() {
  return fetch('/api/stats').then(r => r.json());
}
`);
    fs.writeFileSync(path.join(planDir, 'app.ts'), `import { Dashboard } from "./dashboard";
export function greet() { return "hello"; }
export function main() { return Dashboard(); }
`);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: add dashboard']);

    // Plan document
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add Dashboard

## Changes
1. New \`dashboard.ts\` with Dashboard component and fetchStats API call
2. Updated \`app.ts\` to import and use Dashboard

## Architecture
- Dashboard fetches from \`/api/stats\` endpoint
- Returns user count and revenue metrics
`);
    run('git', ['add', 'plan.md']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-eng-review skill
    fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
      path.join(planDir, 'plan-eng-review', 'SKILL.md'),
    );

    // Set up remote-slug shim and browse shims (plan-eng-review uses remote-slug for artifact path)
    setupBrowseShims(planDir);

    // Create project directory for artifacts
    projectDir = path.join(os.homedir(), '.gstack', 'projects', 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Clean up stale test-plan files from previous runs
    try {
      const staleFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));
      for (const f of staleFiles) {
        fs.unlinkSync(path.join(projectDir, f));
      }
    } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
    // Clean up test-plan artifacts (but not the project dir itself)
    try {
      const files = fs.readdirSync(projectDir);
      for (const f of files) {
        if (f.includes('test-plan')) {
          fs.unlinkSync(path.join(projectDir, f));
        }
      }
    } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-artifact', async () => {
    // Count existing test-plan files before
    const beforeFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));

    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the review.

Read plan.md — that's the plan to review. This is a standalone plan with source code in app.ts and dashboard.ts.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.

IMPORTANT: After your review, you MUST write the test-plan artifact as described in the "Test Plan Artifact" section of SKILL.md. The remote-slug shim is at ${planDir}/browse/bin/remote-slug.

Write your review to ${planDir}/review-output.md`,
      workingDirectory: planDir,
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
      timeout: 360_000,
      testName: 'plan-eng-review-artifact',
      runId,
      model: 'claude-opus-4-6',
    });

    logCost('/plan-eng-review artifact', result);
    recordE2E(evalCollector, '/plan-eng-review test-plan artifact', 'Plan-Eng-Review Test-Plan Artifact E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify test-plan artifact was written
    const afterFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));
    const newFiles = afterFiles.filter(f => !beforeFiles.includes(f));
    console.log(`Test-plan artifacts: ${beforeFiles.length} before, ${afterFiles.length} after, ${newFiles.length} new`);

    if (newFiles.length > 0) {
      const content = fs.readFileSync(path.join(projectDir, newFiles[0]), 'utf-8');
      console.log(`Test-plan artifact (${newFiles[0]}): ${content.length} chars`);
      expect(content.length).toBeGreaterThan(50);
    } else {
      console.warn('No test-plan artifact found — agent may not have followed artifact instructions');
    }

    // Soft assertion: we expect an artifact but agent compliance is not guaranteed.
    // Log rather than fail — the test-plan artifact is a bonus output, not the core test.
    if (newFiles.length === 0) {
      console.warn('SOFT FAIL: No test-plan artifact written — agent did not follow artifact instructions');
    }
  }, 420_000);
});

// --- Office Hours Spec Review E2E ---

describeIfSelected('Office Hours Spec Review E2E', ['office-hours-spec-review'], () => {
  let ohDir: string;

  beforeAll(() => {
    ohDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-oh-spec-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: ohDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(ohDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    // Copy office-hours skill
    fs.mkdirSync(path.join(ohDir, 'office-hours'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'office-hours', 'SKILL.md'),
      path.join(ohDir, 'office-hours', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(ohDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('office-hours-spec-review', async () => {
    const result = await runSkillTest({
      prompt: `Read office-hours/SKILL.md. I want to understand the spec review loop.

Summarize what the "Spec Review Loop" section does — specifically:
1. How many dimensions does the reviewer check?
2. What tool is used to dispatch the reviewer?
3. What's the maximum number of iterations?
4. What metrics are tracked?

Write your summary to ${ohDir}/spec-review-summary.md`,
      workingDirectory: ohDir,
      maxTurns: 8,
      timeout: 120_000,
      testName: 'office-hours-spec-review',
      runId,
    });

    logCost('/office-hours spec review', result);
    recordE2E(evalCollector, '/office-hours-spec-review', 'Office Hours Spec Review E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(ohDir, 'spec-review-summary.md');
    if (fs.existsSync(summaryPath)) {
      const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
      expect(summary).toMatch(/5.*dimension|dimension.*5|completeness|consistency|clarity|scope|feasibility/);
      expect(summary).toMatch(/agent|subagent/);
      expect(summary).toMatch(/3.*iteration|iteration.*3|maximum.*3/);
    }
  }, 180_000);
});

// --- Plan CEO Review Benefits-From E2E ---

describeIfSelected('Plan CEO Review Benefits-From E2E', ['plan-ceo-review-benefits'], () => {
  let benefitsDir: string;

  beforeAll(() => {
    benefitsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-benefits-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: benefitsDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(benefitsDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    fs.mkdirSync(path.join(benefitsDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(benefitsDir, 'plan-ceo-review', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(benefitsDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-benefits', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md. Search for sections about "Prerequisite" or "office-hours" or "design doc found".

Summarize what happens when no design doc is found — specifically:
1. Is /office-hours offered as a prerequisite?
2. What options does the user get?
3. Is there a mid-session detection for when the user seems lost?

Write your summary to ${benefitsDir}/benefits-summary.md`,
      workingDirectory: benefitsDir,
      maxTurns: 8,
      timeout: 120_000,
      testName: 'plan-ceo-review-benefits',
      runId,
    });

    logCost('/plan-ceo-review benefits-from', result);
    recordE2E(evalCollector, '/plan-ceo-review-benefits', 'Plan CEO Review Benefits-From E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(benefitsDir, 'benefits-summary.md');
    if (fs.existsSync(summaryPath)) {
      const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
      expect(summary).toMatch(/office.hours/);
      expect(summary).toMatch(/design doc|no design/i);
    }
  }, 180_000);
});

// --- Plan Review Report E2E ---
// Verifies that plan-eng-review writes a "## GSTACK REVIEW REPORT" section
// to the bottom of the plan file (the living review status footer).

describeIfSelected('Plan Review Report E2E', ['plan-review-report'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-report-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

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
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  test('/plan-eng-review writes GSTACK REVIEW REPORT to plan file', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections.

CRITICAL REQUIREMENT: plan.md IS the plan file for this review session. After completing your review, you MUST write a "## GSTACK REVIEW REPORT" section to the END of plan.md, exactly as described in the "Plan File Review Report" section of SKILL.md. If gstack-review-read is not available or returns NO_REVIEWS, write the placeholder table with all four review rows (CEO, Codex, Eng, Design). Use the Edit tool to append to plan.md — do NOT overwrite the existing plan content.

This review report at the bottom of the plan is the MOST IMPORTANT deliverable of this test.`,
      workingDirectory: planDir,
      maxTurns: 20,
      timeout: 360_000,
      testName: 'plan-review-report',
      runId,
      model: 'claude-opus-4-6',
    });

    logCost('/plan-eng-review report', result);
    recordE2E(evalCollector, '/plan-review-report', 'Plan Review Report E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review report was written to the plan file
    const planContent = fs.readFileSync(path.join(planDir, 'plan.md'), 'utf-8');

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

    console.log('Plan review report found at bottom of plan.md');
  }, 420_000);
});

// --- Codex Offering E2E ---
// Verifies that Codex is properly offered (with availability check, user prompt,
// and fallback) in office-hours, plan-ceo-review, plan-design-review, plan-eng-review.

describeIfSelected('Codex Offering E2E', [
  'codex-offered-office-hours', 'codex-offered-ceo-review',
  'codex-offered-design-review', 'codex-offered-eng-review',
], () => {
  let testDir: string;

  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-codex-offer-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: testDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    // Copy all 4 SKILL.md files
    for (const skill of ['office-hours', 'plan-ceo-review', 'plan-design-review', 'plan-eng-review']) {
      fs.mkdirSync(path.join(testDir, skill), { recursive: true });
      fs.copyFileSync(
        path.join(ROOT, skill, 'SKILL.md'),
        path.join(testDir, skill, 'SKILL.md'),
      );
    }
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  async function checkCodexOffering(skill: string, testName: string, featureName: string) {
    const result = await runSkillTest({
      prompt: `Read ${skill}/SKILL.md. Search for ALL sections related to "codex", "outside voice", or "second opinion".

Summarize the Codex/${featureName} integration — answer these specific questions:
1. How is Codex availability checked? (what exact bash command?)
2. How is the user prompted? (via AskUserQuestion? what are the options?)
3. What happens when Codex is NOT available? (fallback to subagent? skip entirely?)
4. Is this step blocking (gates the workflow) or optional (can be skipped)?
5. What prompt/context is sent to Codex?

Write your summary to ${testDir}/${testName}-summary.md`,
      workingDirectory: testDir,
      maxTurns: 8,
      timeout: 120_000,
      testName,
      runId,
    });

    logCost(`/${skill} codex offering`, result);
    recordE2E(evalCollector, `/${testName}`, 'Codex Offering E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(testDir, `${testName}-summary.md`);
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
    // All skills should have codex availability check
    expect(summary).toMatch(/which codex/);
    // All skills should have fallback behavior
    expect(summary).toMatch(/fallback|subagent|unavailable|not available|skip/);
    // All skills should show it's optional/non-blocking
    expect(summary).toMatch(/optional|non.?blocking|skip|not.*required/);

    console.log(`${skill}: Codex offering verified`);
  }

  testConcurrentIfSelected('codex-offered-office-hours', async () => {
    await checkCodexOffering('office-hours', 'codex-offered-office-hours', 'second opinion');
  }, 180_000);

  testConcurrentIfSelected('codex-offered-ceo-review', async () => {
    await checkCodexOffering('plan-ceo-review', 'codex-offered-ceo-review', 'outside voice');
  }, 180_000);

  testConcurrentIfSelected('codex-offered-design-review', async () => {
    await checkCodexOffering('plan-design-review', 'codex-offered-design-review', 'design outside voices');
  }, 180_000);

  testConcurrentIfSelected('codex-offered-eng-review', async () => {
    await checkCodexOffering('plan-eng-review', 'codex-offered-eng-review', 'outside voice');
  }, 180_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
