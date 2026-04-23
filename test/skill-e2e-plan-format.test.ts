/**
 * AskUserQuestion format regression test for /plan-ceo-review and /plan-eng-review.
 *
 * Context: a user on Opus 4.7 reported the RECOMMENDATION line and the
 * `Completeness: N/10` per-option score stopped appearing on AskUserQuestion
 * prompts. This test captures the agent's AskUserQuestion output verbatim
 * and asserts the format rule is applied.
 *
 * Capture shape: `claude -p` sessions inside this harness do not have the
 * AskUserQuestion MCP tool wired. We instruct the agent to write the verbatim
 * AskUserQuestion text it would have made to $OUT_FILE instead of calling
 * any tool. Assertions read that file.
 *
 * Coverage-vs-kind split: the format rule says to include `Completeness: N/10`
 * only when options differ in coverage. When options differ in kind (mode
 * selection, posture choice, cherry-pick Add/Defer/Skip), the score is
 * intentionally absent and a one-line note explains why. Assertions split
 * accordingly.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-plan-format');

// Regex predicates applied to captured AskUserQuestion content.
// RECOMMENDATION regex is lenient on intervening markdown markers (e.g.
// agent writes `**RECOMMENDATION:** Choose` — the `**` closers are benign).
const RECOMMENDATION_RE = /RECOMMENDATION:[*\s]*Choose/;
const COMPLETENESS_RE = /Completeness:\s*\d{1,2}\/10/;
const KIND_NOTE_RE = /options differ in kind/i;

const SAMPLE_PLAN = `# Plan: Add User Dashboard

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
`;

function setupPlanDir(tmpPrefix: string, skillName: 'plan-ceo-review' | 'plan-eng-review'): string {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);

  fs.writeFileSync(path.join(planDir, 'plan.md'), SAMPLE_PLAN);
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'add plan']);

  fs.mkdirSync(path.join(planDir, skillName), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, skillName, 'SKILL.md'),
    path.join(planDir, skillName, 'SKILL.md'),
  );

  return planDir;
}

// The capture instruction passed to every case. Tells the agent to dump
// AskUserQuestion content to a file instead of calling a tool.
function captureInstruction(outFile: string): string {
  return `Write the verbatim text of every AskUserQuestion you would have made to ${outFile} (one question per session, full text including options and recommendation line). Do NOT call any tool to ask the user. Do NOT paraphrase — include the exact prose you would have shown. This is a format-capture test, not an interactive session.`;
}

// --- Case 1: plan-ceo-review mode selection (kind-differentiated) ---

describeIfSelected('Plan Format — CEO Mode Selection', ['plan-ceo-review-format-mode'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-format-ceo-mode-', 'plan-ceo-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-format-mode', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Proceed to Step 0F (Mode Selection). This is where the skill presents 4 mode options (SCOPE EXPANSION, SELECTIVE EXPANSION, HOLD SCOPE, SCOPE REDUCTION) to the user via AskUserQuestion. These options differ in kind (review posture), not in coverage.

${captureInstruction(outFile)}

After writing the file, stop. Do not continue the review.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-ceo-review-format-mode',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review format (mode)', result);
    recordE2E(evalCollector, '/plan-ceo-review-format-mode', 'Plan Format — CEO Mode Selection', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(100);

    // Kind-differentiated: RECOMMENDATION required, Completeness: N/10 must NOT appear,
    // "options differ in kind" note must appear.
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).not.toMatch(COMPLETENESS_RE);
    expect(captured).toMatch(KIND_NOTE_RE);
  }, 300_000);
});

// --- Case 2: plan-ceo-review approach menu (coverage-differentiated) ---

describeIfSelected('Plan Format — CEO Approach Menu', ['plan-ceo-review-format-approach'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-format-ceo-approach-', 'plan-ceo-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-format-approach', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Proceed to Step 0C-bis (Implementation Alternatives / Approach Menu). This is where the skill generates 2-3 approaches (minimal viable vs ideal architecture) and presents them via AskUserQuestion. These options differ in coverage (complete vs shortcut), so Completeness: N/10 applies.

${captureInstruction(outFile)}

After writing the file, stop. Do not continue the review.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-ceo-review-format-approach',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review format (approach)', result);
    recordE2E(evalCollector, '/plan-ceo-review-format-approach', 'Plan Format — CEO Approach Menu', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(100);

    // Coverage-differentiated: both RECOMMENDATION and Completeness: N/10 required.
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).toMatch(COMPLETENESS_RE);
  }, 300_000);
});

// --- Case 3: plan-eng-review coverage-differentiated per-issue AskUserQuestion ---

describeIfSelected('Plan Format — Eng Coverage Issue', ['plan-eng-review-format-coverage'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-format-eng-cov-', 'plan-eng-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-format-coverage', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

During your review (Section 3 Test Review is the natural place), generate ONE AskUserQuestion about test coverage depth where the options are clearly coverage-differentiated. For example:
  A) Full coverage: happy path + edge cases + error paths (Completeness 10/10)
  B) Happy path only (Completeness 7/10)
  C) Smoke test (Completeness 3/10)

${captureInstruction(outFile)}

After writing the file with that ONE question, stop. Do not continue the review.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-eng-review-format-coverage',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-eng-review format (coverage)', result);
    recordE2E(evalCollector, '/plan-eng-review-format-coverage', 'Plan Format — Eng Coverage Issue', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(100);

    // Coverage-differentiated: both RECOMMENDATION and Completeness: N/10 required.
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).toMatch(COMPLETENESS_RE);
  }, 300_000);
});

// --- Case 4: plan-eng-review kind-differentiated per-issue AskUserQuestion ---

describeIfSelected('Plan Format — Eng Kind Issue', ['plan-eng-review-format-kind'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-format-eng-kind-', 'plan-eng-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-format-kind', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

During your review (Section 1 Architecture), generate ONE AskUserQuestion about an architectural choice where the options differ in kind, not in coverage. For example, "should we use Redis or Postgres for the cache layer?" — the options are different kinds of systems with different tradeoffs, not more-or-less-complete versions of the same thing.

${captureInstruction(outFile)}

After writing the file with that ONE question, stop. Do not continue the review.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-eng-review-format-kind',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-eng-review format (kind)', result);
    recordE2E(evalCollector, '/plan-eng-review-format-kind', 'Plan Format — Eng Kind Issue', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(100);

    // Kind-differentiated: RECOMMENDATION required, Completeness: N/10 must NOT appear,
    // "options differ in kind" note must appear.
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).not.toMatch(COMPLETENESS_RE);
    expect(captured).toMatch(KIND_NOTE_RE);
  }, 300_000);
});

afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
