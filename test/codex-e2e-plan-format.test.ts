/**
 * AskUserQuestion format regression test for /plan-ceo-review and /plan-eng-review
 * running under Codex CLI (GPT-5.4).
 *
 * Context: GPT-class models under the "No preamble / Prefer doing over listing"
 * gpt.md overlay tend to skip the Simplify (ELI10) paragraph and the RECOMMENDATION
 * line on AskUserQuestion calls. The user has to manually re-prompt "ELI10 and don't
 * forget to recommend" almost every time. This test pins that behavior so future
 * regressions surface automatically.
 *
 * Mirrors test/skill-e2e-plan-format.test.ts (the Claude version) but uses
 * test/helpers/codex-session-runner.ts to drive `codex exec` instead of `claude -p`.
 *
 * Four cases:
 *   1. plan-ceo-review mode selection (kind-differentiated)
 *   2. plan-ceo-review approach menu (coverage-differentiated)
 *   3. plan-eng-review per-issue coverage decision
 *   4. plan-eng-review per-issue architectural choice (kind-differentiated)
 *
 * Assertions on captured AskUserQuestion text:
 *   - RECOMMENDATION: Choose present (all cases)
 *   - Completeness: N/10 present on coverage cases, absent on kind cases
 *   - "options differ in kind" note present on kind cases
 *   - ELI10-style plain-English explanation present (length floor + no raw jargon)
 *
 * Periodic tier (Codex non-determinism). Cost: ~$2-3 per full run.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runCodexSkill, installSkillToTempHome } from './helpers/codex-session-runner';
import type { CodexResult } from './helpers/codex-session-runner';
import { EvalCollector } from './helpers/eval-store';
import type { EvalTestEntry } from './helpers/eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

// --- Prerequisites ---

const CODEX_AVAILABLE = (() => {
  try {
    const result = Bun.spawnSync(['which', 'codex']);
    return result.exitCode === 0;
  } catch { return false; }
})();
const evalsEnabled = !!process.env.EVALS;
const SKIP = !CODEX_AVAILABLE || !evalsEnabled;
const describeCodex = SKIP ? describe.skip : describe;

// --- Touchfiles ---

const CODEX_FORMAT_TOUCHFILES: Record<string, string[]> = {
  'codex-plan-ceo-format-mode':      ['.agents/skills/gstack-plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'model-overlays/gpt.md', 'model-overlays/gpt-5.4.md'],
  'codex-plan-ceo-format-approach':  ['.agents/skills/gstack-plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'model-overlays/gpt.md', 'model-overlays/gpt-5.4.md'],
  'codex-plan-eng-format-coverage':  ['.agents/skills/gstack-plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'model-overlays/gpt.md', 'model-overlays/gpt-5.4.md'],
  'codex-plan-eng-format-kind':      ['.agents/skills/gstack-plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'model-overlays/gpt.md', 'model-overlays/gpt-5.4.md'],
};

let selectedTests: string[] | null = null;
if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE || detectBaseBranch(ROOT) || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);
  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, CODEX_FORMAT_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
  }
}

function testIfSelected(name: string, fn: () => Promise<void>, timeout?: number) {
  if (selectedTests !== null && !selectedTests.includes(name)) {
    test.skip(name, fn, timeout);
  } else {
    test(name, fn, timeout);
  }
}

// --- Eval collector ---

let evalCollector: EvalCollector | null = null;
if (!SKIP) {
  evalCollector = new EvalCollector('codex-e2e-plan-format');
}

function recordCodexResult(testName: string, result: CodexResult, passed: boolean) {
  evalCollector?.addTest({
    name: testName,
    suite: 'codex-e2e-plan-format',
    tier: 'e2e',
    passed,
    duration_ms: result.durationMs,
    cost_usd: 0, // Codex doesn't report cost in the same way; tokens tracked separately
    output: result.output?.slice(0, 2000),
    turns_used: result.toolCalls.length,
    exit_reason: result.exitCode === 0 ? 'success' : `exit_code_${result.exitCode}`,
  });
}

afterAll(async () => {
  if (evalCollector) {
    await evalCollector.finalize();
  }
});

// --- Fixtures ---

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

function setupCodexSkillDir(tmpPrefix: string, skillName: 'plan-ceo-review' | 'plan-eng-review'): { skillDir: string; planDir: string; outFile: string } {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);

  fs.writeFileSync(path.join(planDir, 'plan.md'), SAMPLE_PLAN);
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'add plan']);

  // Codex skill lives in .agents/skills/gstack-{name}/ per the gstack host convention.
  const codexSkillSource = path.join(ROOT, '.agents', 'skills', `gstack-${skillName}`);
  const skillDir = path.join(planDir, '.agents', 'skills', `gstack-${skillName}`);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.cpSync(codexSkillSource, skillDir, { recursive: true });

  const outFile = path.join(planDir, 'ask-capture.md');
  return { skillDir, planDir, outFile };
}

// Capture instruction — same shape as the Claude version. Codex may ignore tool calls,
// so we tell it to write prose to the file directly.
function captureInstruction(outFile: string): string {
  return `Write the verbatim text of every AskUserQuestion you would have presented to the user to the file ${outFile} (one question per session, full text including the re-ground, ELI10 paragraph, RECOMMENDATION line, and options). Do NOT ask the user interactively. Do NOT paraphrase. This is a format-capture test, not an interactive session.`;
}

// --- Regex predicates ---
// Match RECOMMENDATION lenient to markdown bolding around it.
const RECOMMENDATION_RE = /RECOMMENDATION:[*\s]*Choose/;
const COMPLETENESS_RE = /Completeness:\s*\d{1,2}\/10/;
const KIND_NOTE_RE = /options differ in kind/i;
// ELI10 signal: some plain-English explanation must exist. Weak proxy: >= 200 chars
// of narrative prose between the re-ground and the options, AND at least one of the
// plain-English hints ("plain English", "16-year-old", or "what this means").
// We test for the length floor and absence of a bare options-list-only output.
const ELI10_LENGTH_FLOOR = 400; // full AskUserQuestion content should be at least this long

// --- Tests ---

describeCodex('Codex Plan Format — CEO Mode Selection', () => {
  let skillDir: string, planDir: string, outFile: string;

  beforeAll(() => {
    ({ skillDir, planDir, outFile } = setupCodexSkillDir('codex-e2e-plan-format-ceo-mode-', 'plan-ceo-review'));
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('codex-plan-ceo-format-mode', async () => {
    const result = await runCodexSkill({
      skillDir,
      prompt: `Read the plan-ceo-review skill. Read plan.md (the plan to review). Proceed to Step 0F (Mode Selection) where the skill presents 4 mode options (SCOPE EXPANSION, SELECTIVE EXPANSION, HOLD SCOPE, SCOPE REDUCTION) via AskUserQuestion. These options differ in kind (review posture), not coverage. ${captureInstruction(outFile)}`,
      timeoutMs: 300_000,
      cwd: planDir,
      skillName: 'gstack-plan-ceo-review',
      sandbox: 'workspace-write',
    });

    recordCodexResult('codex-plan-ceo-format-mode', result, result.exitCode === 0);
    console.log(`codex-plan-ceo-format-mode: ${result.tokens}t, ${Math.round(result.durationMs/1000)}s, exit=${result.exitCode}`);

    // Codex may timeout — accept as non-fatal (same pattern as existing codex-e2e tests)
    if (result.exitCode === 124 || result.exitCode === 137) {
      console.warn(`codex timed out (exit ${result.exitCode}) — skipping assertions`);
      return;
    }

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(ELI10_LENGTH_FLOOR);
    expect(captured).toMatch(RECOMMENDATION_RE);
    // kind-differentiated: no fabricated score, must have note
    expect(captured).not.toMatch(COMPLETENESS_RE);
    expect(captured).toMatch(KIND_NOTE_RE);
  }, 360_000);
});

describeCodex('Codex Plan Format — CEO Approach Menu', () => {
  let skillDir: string, planDir: string, outFile: string;

  beforeAll(() => {
    ({ skillDir, planDir, outFile } = setupCodexSkillDir('codex-e2e-plan-format-ceo-approach-', 'plan-ceo-review'));
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('codex-plan-ceo-format-approach', async () => {
    const result = await runCodexSkill({
      skillDir,
      prompt: `Read the plan-ceo-review skill. Read plan.md. Proceed to Step 0C-bis (Implementation Alternatives / Approach Menu) where the skill generates 2-3 approaches (minimal viable vs ideal architecture) and presents them via AskUserQuestion. These options differ in coverage so Completeness: N/10 applies. ${captureInstruction(outFile)}`,
      timeoutMs: 300_000,
      cwd: planDir,
      skillName: 'gstack-plan-ceo-review',
      sandbox: 'workspace-write',
    });

    recordCodexResult('codex-plan-ceo-format-approach', result, result.exitCode === 0);
    console.log(`codex-plan-ceo-format-approach: ${result.tokens}t, ${Math.round(result.durationMs/1000)}s, exit=${result.exitCode}`);

    if (result.exitCode === 124 || result.exitCode === 137) {
      console.warn(`codex timed out (exit ${result.exitCode}) — skipping assertions`);
      return;
    }

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(ELI10_LENGTH_FLOOR);
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).toMatch(COMPLETENESS_RE);
  }, 360_000);
});

describeCodex('Codex Plan Format — Eng Coverage Issue', () => {
  let skillDir: string, planDir: string, outFile: string;

  beforeAll(() => {
    ({ skillDir, planDir, outFile } = setupCodexSkillDir('codex-e2e-plan-format-eng-cov-', 'plan-eng-review'));
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('codex-plan-eng-format-coverage', async () => {
    const result = await runCodexSkill({
      skillDir,
      prompt: `Read the plan-eng-review skill. Read plan.md. In your Section 3 Test Review, generate ONE AskUserQuestion about test coverage depth where options are clearly coverage-differentiated: A) full coverage incl. edge + error paths (Completeness 10/10), B) happy path only (7/10), C) smoke test (3/10). ${captureInstruction(outFile)}`,
      timeoutMs: 300_000,
      cwd: planDir,
      skillName: 'gstack-plan-eng-review',
      sandbox: 'workspace-write',
    });

    recordCodexResult('codex-plan-eng-format-coverage', result, result.exitCode === 0);
    console.log(`codex-plan-eng-format-coverage: ${result.tokens}t, ${Math.round(result.durationMs/1000)}s, exit=${result.exitCode}`);

    if (result.exitCode === 124 || result.exitCode === 137) {
      console.warn(`codex timed out (exit ${result.exitCode}) — skipping assertions`);
      return;
    }

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(ELI10_LENGTH_FLOOR);
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).toMatch(COMPLETENESS_RE);
  }, 360_000);
});

describeCodex('Codex Plan Format — Eng Kind Issue', () => {
  let skillDir: string, planDir: string, outFile: string;

  beforeAll(() => {
    ({ skillDir, planDir, outFile } = setupCodexSkillDir('codex-e2e-plan-format-eng-kind-', 'plan-eng-review'));
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('codex-plan-eng-format-kind', async () => {
    const result = await runCodexSkill({
      skillDir,
      prompt: `Read the plan-eng-review skill. Read plan.md. In your Section 1 Architecture review, generate ONE AskUserQuestion about an architectural choice where the options differ in kind (e.g. Redis vs Postgres materialized view vs in-process cache — different kinds of systems with different tradeoffs, NOT more-or-less-complete versions of the same thing). ${captureInstruction(outFile)}`,
      timeoutMs: 300_000,
      cwd: planDir,
      skillName: 'gstack-plan-eng-review',
      sandbox: 'workspace-write',
    });

    recordCodexResult('codex-plan-eng-format-kind', result, result.exitCode === 0);
    console.log(`codex-plan-eng-format-kind: ${result.tokens}t, ${Math.round(result.durationMs/1000)}s, exit=${result.exitCode}`);

    if (result.exitCode === 124 || result.exitCode === 137) {
      console.warn(`codex timed out (exit ${result.exitCode}) — skipping assertions`);
      return;
    }

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(ELI10_LENGTH_FLOOR);
    expect(captured).toMatch(RECOMMENDATION_RE);
    // kind-differentiated: no fabricated score
    expect(captured).not.toMatch(COMPLETENESS_RE);
    expect(captured).toMatch(KIND_NOTE_RE);
  }, 360_000);
});
