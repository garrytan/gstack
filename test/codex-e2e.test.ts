/**
 * Codex CLI E2E tests — verify skills work when invoked by Codex.
 *
 * Spawns `codex exec` with skills installed in a temp HOME, parses JSONL
 * output, and validates structured results. Follows the same pattern as
 * the skill-e2e-*.test.ts suites but adapted for Codex CLI.
 *
 * Prerequisites:
 * - `codex` binary installed (npm install -g @openai/codex)
 * - Codex authenticated via ~/.codex/ config (no OPENAI_API_KEY env var needed)
 * - EVALS=1 env var set (same gate as Claude E2E tests)
 *
 * Skips gracefully when prerequisites are not met.
 */

import { describe, test, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runCodexSkill } from './helpers/codex-session-runner';
import { CODEX_EVAL_FINALIZE_MS, createCodexEvalCollector, runRecordedCodexEval, validateCodexDiscovery, validateCodexReview } from './helpers/codex-eval';
import type { CodexResult } from './helpers/codex-session-runner';
import { CODEX_REVIEW_E2E_SECTIONS } from './helpers/skill-fixture';
import { selectTests, detectBaseBranch, getChangedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { createTestWorktree, harvestAndCleanup } from './helpers/e2e-helpers';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// --- Prerequisites check ---

const CODEX_AVAILABLE = (() => {
  try {
    const result = Bun.spawnSync(['which', 'codex'], { timeout: 30_000 });
    return result.exitCode === 0;
  } catch { return false; }
})();

const evalsEnabled = !!process.env.EVALS;

// External-service tests are periodic-tier (CLAUDE.md tiering rule 3):
// "Requires external service (Codex, Gemini)? -> periodic". The positive
// form below is the canonical whole-file guard shape — the sharded runner's
// classifyPaidTestFile greps for it to exclude this file from gate.
const tierOk = process.env.EVALS_TIER === 'periodic';

// Skip all tests if codex is not available, EVALS is not set, or we're in
// the gate tier.
// Note: Codex uses its own auth from ~/.codex/ config — no OPENAI_API_KEY env var needed.
const SKIP = !CODEX_AVAILABLE || !evalsEnabled || !tierOk;

const describeCodex = SKIP ? describe.skip : describe;

// Log why we're skipping (helpful for debugging CI)
if (!evalsEnabled) {
  // Silent — same as Claude E2E tests, EVALS=1 required
} else if (!tierOk) {
  process.stderr.write('\nCodex E2E: SKIPPED — external-service test, periodic tier only (EVALS_TIER === \'periodic\')\n');
} else if (!CODEX_AVAILABLE) {
  process.stderr.write('\nCodex E2E: SKIPPED — codex binary not found (install: npm i -g @openai/codex)\n');
}

// --- Diff-based test selection ---

// Codex E2E touchfiles — DERIVED from the canonical map, never a local fork.
// The old hand-copy drifted (it kept gitignored '.agents/skills/**' patterns
// that can never match a git diff, and missed deps the canonical map gained
// like lib/worktree.ts and this test file itself), so review-template edits
// silently stopped selecting these tests. Deriving keeps one source of truth
// and puts these keys under the tier-alignment + dep-existence invariants.
const CODEX_E2E_TOUCHFILES: Record<string, string[]> = Object.fromEntries(
  (['codex-discover-skill', 'codex-review-findings'] as const).map((key) => {
    if (!E2E_TOUCHFILES[key]) throw new Error(`canonical E2E_TOUCHFILES lost key '${key}' — fix the map, not this file`);
    return [key, E2E_TOUCHFILES[key]];
  }),
);

let selectedTests: string[] | null = null; // null = run all

if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);

  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, CODEX_E2E_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
    process.stderr.write(`\nCodex E2E selection (${selection.reason}): ${selection.selected.length}/${Object.keys(CODEX_E2E_TOUCHFILES).length} tests\n`);
    if (selection.skipped.length > 0) {
      process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
    }
    process.stderr.write('\n');
  }
  // If changedFiles is empty (e.g., on main branch), selectedTests stays null -> run all
}

/** Skip an individual test if not selected by diff-based selection. */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test.concurrent : test.skip)(testName, fn, timeout + CODEX_EVAL_FINALIZE_MS);
}

// --- Eval result collector ---

const evalCollector = evalsEnabled && !SKIP ? createCodexEvalCollector('codex-e2e') : null;

/** Print cost summary after a Codex E2E test. */
function logCodexCost(label: string, result: CodexResult) {
  const durationSec = Math.round(result.durationMs / 1000);
  console.log(`${label}: ${result.tokens} tokens, ${result.toolCalls.length} tool calls, ${durationSec}s`);
}

// Finalize eval results on exit
afterAll(async () => {
  if (evalCollector) {
    await evalCollector.finalize();
  }
});

// --- Tests ---

describeCodex('Codex E2E', () => {
  let testWorktree: string;

  beforeAll(() => {
    testWorktree = createTestWorktree('codex');
  });

  afterAll(() => {
    harvestAndCleanup('codex');
  });

  testIfSelected('codex-discover-skill', async () => {
    // Install gstack-review skill to a temp HOME and ask Codex to list skills.
    // Deliberately installs the FULL generated SKILL.md (no `sections`): this
    // test's purpose is to prove the real artifact loads under Codex — the
    // stderr assertions below ('invalid' / 'Skipped loading') would be
    // meaningless against an extracted fixture.
    const skillDir = path.join(testWorktree, '.agents', 'skills', 'gstack-review');

    const result = await runRecordedCodexEval({
      name: 'codex-discover-skill',
      suite: 'codex-e2e',
      budgetMs: JUDGE_MS,
      run: (signal) => runCodexSkill({
        skillDir,
        prompt: 'List any skills or instructions you have available. Just list the names.',
        timeoutMs: JUDGE_MS,
        cwd: testWorktree,
        skillName: 'gstack-review',
        signal,
      }),
      validate: validateCodexDiscovery,
      record: (entry) => evalCollector?.addTest(entry),
    });
    logCodexCost('codex-discover-skill', result);
  }, JUDGE_MS);

  // Validates that Codex can invoke the gstack-review skill, run a diff-based
  // code review, and produce structured review output with findings/issues.
  testIfSelected('codex-review-findings', async () => {
    // Install gstack-review and ask Codex to review the worktree. The skill
    // fixture is EXTRACTED to the core review-workflow sections — the full
    // Codex host variant is ~1460 lines and this test only exercises the
    // diff-review flow (CLAUDE.md: "E2E test fixtures: extract, don't copy").
    const skillDir = path.join(testWorktree, '.agents', 'skills', 'gstack-review');

    const result = await runRecordedCodexEval({
      name: 'codex-review-findings',
      suite: 'codex-e2e',
      budgetMs: CAPTURE_LONG_MS,
      run: (signal) => runCodexSkill({
        skillDir,
        prompt: 'Run the gstack-review skill on this repository. Review the current branch diff and report your findings.',
        timeoutMs: CAPTURE_LONG_MS,
        cwd: testWorktree,
        skillName: 'gstack-review',
        sections: CODEX_REVIEW_E2E_SECTIONS,
        signal,
      }),
      validate: validateCodexReview,
      record: (entry) => evalCollector?.addTest(entry),
    });
    logCodexCost('codex-review-findings', result);
  }, CAPTURE_LONG_MS);
});
