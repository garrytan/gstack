/**
 * v1.7.0.0 Pros/Cons format regression tests for plan reviews.
 *
 * Extends the v1.6.3.0 format harness (skill-e2e-plan-format.test.ts) with
 * four new cases covering the Pros/Cons decision-brief format:
 *
 * 1. Format positive — every AskUserQuestion renders with D<N> / ELI10 /
 *    Stakes / Recommendation / Pros/cons / ✅×2+ / ❌×1+ / Net tokens.
 * 2. Hard-stop positive — destructive-action question may use the single
 *    "No cons — this is a hard-stop choice" escape.
 * 3. Hard-stop NEGATIVE (CT2) — plan with genuine tradeoff, model must NOT
 *    dodge to the hard-stop escape. Forces real tradeoff articulation.
 * 4. Neutral-posture NEGATIVE (CT2) — plan with one clearly-dominant option,
 *    model must emit (recommended) label and concrete recommendation, NOT
 *    "no preference — taste call" dodge.
 *
 * Capture pattern matches existing harness: agent writes verbatim
 * AskUserQuestion text to $OUT_FILE; regex predicates run on the captured
 * file. Classified periodic (Opus 4.7 non-deterministic).
 *
 * FOLLOW-UP (not in v1.7.0.0):
 * - True cadence eval (3 findings → 3 distinct asks across turns). Current
 *   $OUT_FILE harness captures ONE would-be question per session. Multi-turn
 *   cadence needs new harness support. Filed in TODOs.
 * - Expanded coverage for /ship /office-hours /investigate /qa /review
 *   /design-review /document-release. Touchfiles entries already exist; eval
 *   cases will land as follow-up PRs per skill.
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

const evalCollector = createEvalCollector('e2e-plan-prosons');

// v1.7.0.0 format tokens
const D_NUMBER_RE = /D\d+\s+—/;
const ELI10_RE = /ELI10:/i;
const STAKES_RE = /Stakes if we pick wrong:/i;
const RECOMMENDATION_RE = /[Rr]ecommendation:/;
const PROS_CONS_HEADER_RE = /Pros\s*\/\s*cons:/i;
const NET_LINE_RE = /^Net:/m;
const HARD_STOP_ESCAPE_RE = /✅\s+No cons\s+—\s+this is a hard-stop choice/;
const NEUTRAL_POSTURE_RE = /taste call/i;
const RECOMMENDED_LABEL_RE = /\(recommended\)/;

function countChars(text: string, char: string): number {
  return (text.match(new RegExp(char, 'g')) || []).length;
}

const TRADEOFF_PLAN = `# Plan: Add user dashboard caching

## Context
Dashboard renders in 3s on cold load, 800ms on warm cache. Users complain.

## Approach options

### Option A: Redis cache layer (complete)
- Add Redis with 5min TTL for dashboard aggregates.
- Cold path: compute + cache. Warm path: fetch from cache.
- Needs Redis infra, cache invalidation logic for activity updates.
- Covers all users, all flows, fails gracefully on cache miss.

### Option B: In-memory LRU cache (happy path only)
- Per-process LRU with 100-entry cap.
- No cross-process sharing; cache warms per-pod.
- Skips cache invalidation; stale reads up to 5min.

Both options have real pros and cons. This is a genuine tradeoff.
`;

const HARDSTOP_PLAN = `# Plan: Delete all user sessions

## Context
Security incident. All active sessions need to be terminated immediately.

## Action
Run \`DELETE FROM sessions WHERE TRUE\`. No dry-run mode.

This is a one-way door. There is no "partial" version.
`;

const DOMINANT_PLAN = `# Plan: Add input validation to signup endpoint

## Context
Signup endpoint currently accepts any email string and any password length.
Bug report: users type gibberish, signup succeeds, they can't log in.

## Options

### Option A: Full RFC 5322 email validation + min 8-char password + server-side checks
- Catches malformed emails, rejects weak passwords, validated on server.
- Prevents the reported bug and adjacent bugs.
- Standard web practice.

### Option B: Client-side type="email" only, no password validation
- Only catches some browsers' built-in validation.
- Attackers bypass by disabling JS.
- Does not fix the reported bug.

Option A clearly dominates on coverage. This is NOT a taste call.
`;

function setupPlanDir(tmpPrefix: string, planContent: string, skillName: string): string {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);

  fs.writeFileSync(path.join(planDir, 'plan.md'), planContent);
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'add plan']);

  fs.mkdirSync(path.join(planDir, skillName), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, skillName, 'SKILL.md'),
    path.join(planDir, skillName, 'SKILL.md'),
  );

  return planDir;
}

function captureInstruction(outFile: string): string {
  return `Write the verbatim text of the single AskUserQuestion you would have made to ${outFile} (full text including D<N> header, ELI10, Stakes, Recommendation, Pros/cons, and Net line — the complete rich markdown body). Do NOT call any tool to ask the user. Do NOT paraphrase. This is a format-capture test.`;
}

// --- Case 1: Format positive — all v1.7.0.0 tokens present ---

describeIfSelected('Plan Prosons — Format Positive', ['plan-review-prosons-format'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-prosons-format-', TRADEOFF_PLAN, 'plan-ceo-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-review-prosons-format', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — two cache approaches with real tradeoffs. Pick the architectural approach via AskUserQuestion (Step 0C-bis / Implementation Alternatives). These options differ in coverage.

${captureInstruction(outFile)}

After writing the file, stop.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-review-prosons-format',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-review prosons format positive', result);
    recordE2E(evalCollector, '/plan-review-prosons-format', 'Plan Prosons — Format Positive', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(200);

    // Every Pros/Cons token present
    expect(captured).toMatch(D_NUMBER_RE);
    expect(captured).toMatch(ELI10_RE);
    expect(captured).toMatch(STAKES_RE);
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).toMatch(PROS_CONS_HEADER_RE);
    expect(captured).toMatch(NET_LINE_RE);

    // Pro/con bullet counts: ≥2 ✅ and ≥1 ❌ per option (total ≥4 ✅ and ≥2 ❌ for 2 options)
    expect(countChars(captured, '✅')).toBeGreaterThanOrEqual(4);
    expect(countChars(captured, '❌')).toBeGreaterThanOrEqual(2);

    // (recommended) label on one option
    expect(captured).toMatch(RECOMMENDED_LABEL_RE);
  }, 300_000);
});

// --- Case 2: Hard-stop escape NEGATIVE (CT2) ---

describeIfSelected('Plan Prosons — Hard-stop Negative', ['plan-review-prosons-hardstop-neg'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-prosons-hardstop-neg-', TRADEOFF_PLAN, 'plan-ceo-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-review-prosons-hardstop-neg', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md.

Read plan.md — this has REAL tradeoffs between Redis and in-memory caching (both have pros and cons). Pick the architectural approach via AskUserQuestion.

${captureInstruction(outFile)}

After writing the file, stop.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-review-prosons-hardstop-neg',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-review prosons hard-stop negative', result);
    recordE2E(evalCollector, '/plan-review-prosons-hardstop-neg', 'Plan Prosons — Hard-stop Negative', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(200);

    // Genuine tradeoff — must NOT dodge to hard-stop escape.
    expect(captured).not.toMatch(HARD_STOP_ESCAPE_RE);
    // Must have real pros and cons (≥2 ✅ + ≥1 ❌ per option)
    expect(countChars(captured, '✅')).toBeGreaterThanOrEqual(4);
    expect(countChars(captured, '❌')).toBeGreaterThanOrEqual(2);
  }, 300_000);
});

// --- Case 3: Neutral-posture NEGATIVE (CT2) ---

describeIfSelected('Plan Prosons — Neutral-posture Negative', ['plan-review-prosons-neutral-neg'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-prosons-neutral-neg-', DOMINANT_PLAN, 'plan-ceo-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-review-prosons-neutral-neg', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md.

Read plan.md — Option A dominates Option B on coverage. This is NOT a taste call. Pick the approach via AskUserQuestion (Step 0C-bis / Implementation Alternatives — coverage-differentiated, so Completeness: N/10 applies).

${captureInstruction(outFile)}

After writing the file, stop.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-review-prosons-neutral-neg',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-review prosons neutral negative', result);
    recordE2E(evalCollector, '/plan-review-prosons-neutral-neg', 'Plan Prosons — Neutral Negative', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(200);

    // One option dominates — must NOT use "taste call" neutral-posture dodge.
    expect(captured).not.toMatch(NEUTRAL_POSTURE_RE);
    // (recommended) label MUST be present on the dominant option.
    expect(captured).toMatch(RECOMMENDED_LABEL_RE);
    // Recommendation line must contain "because" (concrete reason, not "no preference")
    expect(captured).toMatch(/[Rr]ecommendation:.*because/);
  }, 300_000);
});

// --- Case 4: Hard-stop POSITIVE (escape allowed when legitimately one-sided) ---

describeIfSelected('Plan Prosons — Hard-stop Positive', ['plan-ceo-review-prosons-cadence'], () => {
  let planDir: string;
  let outFile: string;

  beforeAll(() => {
    planDir = setupPlanDir('skill-e2e-plan-prosons-hardstop-pos-', HARDSTOP_PLAN, 'plan-ceo-review');
    outFile = path.join(planDir, 'ask-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-prosons-cadence', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md.

Read plan.md — this is a destructive one-way action (terminate all sessions). Ask the user to confirm via AskUserQuestion. This is a legitimate hard-stop choice — the hard-stop escape (\`✅ No cons — this is a hard-stop choice\`) is allowed here because there is no meaningful alternative besides doing or not doing the action.

${captureInstruction(outFile)}

After writing the file, stop.`,
      workingDirectory: planDir,
      maxTurns: 10,
      timeout: 240_000,
      testName: 'plan-ceo-review-prosons-cadence',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-review prosons hard-stop positive', result);
    recordE2E(evalCollector, '/plan-ceo-review-prosons-cadence', 'Plan Prosons — Hard-stop Positive', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(100);

    // Format scaffolding still required
    expect(captured).toMatch(PROS_CONS_HEADER_RE);
    // Hard-stop escape is ACCEPTED here (destructive one-way action)
    // Either the escape is used OR real pros/cons are present — both are valid.
    const hasEscape = HARD_STOP_ESCAPE_RE.test(captured);
    const hasProsAndCons = countChars(captured, '✅') >= 1 && countChars(captured, '❌') >= 1;
    expect(hasEscape || hasProsAndCons).toBe(true);
  }, 300_000);
});

afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
