/**
 * Gemini CLI E2E smoke test — verify Gemini CLI can start and discover skills.
 *
 * This is a lightweight smoke test, not a full integration test. Gemini CLI
 * gets lost in worktrees and times out on complex tasks. The smoke test
 * validates that the skill files are structured correctly for Gemini's
 * .agents/skills/ discovery mechanism.
 *
 * Prerequisites:
 * - `gemini` binary installed (npm install -g @google/gemini-cli)
 * - Gemini authenticated via ~/.gemini/ config or GEMINI_API_KEY env var
 * - EVALS=1 env var set (same gate as Claude E2E tests)
 *
 * Skips gracefully when prerequisites are not met.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS } from './helpers/eval-budgets';
import { runGeminiSkill } from './helpers/gemini-session-runner';
import type { GeminiResult } from './helpers/gemini-session-runner';
import { EvalCollector } from './helpers/eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { createTestWorktree, harvestAndCleanup } from './helpers/e2e-helpers';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// --- Prerequisites check ---

const GEMINI_AVAILABLE = (() => {
  try {
    const result = Bun.spawnSync(['which', 'gemini']);
    return result.exitCode === 0;
  } catch { return false; }
})();

// A binary on PATH is not enough: the CLI can be present but UNUSABLE — the
// individual code-assist auth path was deprecated upstream ("migrate to the
// Antigravity suite"), which fails every run before any model call, and flag
// churn (--skip-trust removed in 0.34) errors at argv parse. Probe with a
// bare --help: a CLI that can't even print usage is unusable, and a working
// one is cheap to confirm. Deeper auth failures are classified per-run.
const GEMINI_USABLE = GEMINI_AVAILABLE && (() => {
  try {
    const result = Bun.spawnSync(['gemini', '--help'], { timeout: 15_000 });
    return result.exitCode === 0;
  } catch { return false; }
})();

const evalsEnabled = !!process.env.EVALS;

// External-service tests are periodic-tier (CLAUDE.md tiering rule 3):
// "Requires external service (Codex, Gemini)? -> periodic". The positive
// form below is the canonical whole-file guard shape — the sharded runner's
// classifyPaidTestFile greps for it to exclude this file from gate.
const tierOk = process.env.EVALS_TIER === 'periodic';

// Skip all tests if gemini is not available/usable, EVALS is not set, or
// we're in the gate tier.
const SKIP = !GEMINI_USABLE || !evalsEnabled || !tierOk;

const describeGemini = SKIP ? describe.skip : describe;

// Log why we're skipping (helpful for debugging CI)
if (!evalsEnabled) {
  // Silent — same as Claude E2E tests, EVALS=1 required
} else if (!tierOk) {
  process.stderr.write('\nGemini E2E: SKIPPED — external-service test, periodic tier only (EVALS_TIER === \'periodic\')\n');
} else if (!GEMINI_AVAILABLE) {
  process.stderr.write('\nGemini E2E: SKIPPED — gemini binary not found (install: npm i -g @google/gemini-cli)\n');
} else if (!GEMINI_USABLE) {
  process.stderr.write('\nGemini E2E: SKIPPED — gemini CLI present but unusable (auth path deprecated upstream or CLI broken; try updating @google/gemini-cli)\n');
}

// --- Diff-based test selection ---

// Gemini E2E touchfiles — keyed by test name
const GEMINI_E2E_TOUCHFILES: Record<string, string[]> = {
  'gemini-smoke':  ['.agents/skills/**', 'test/helpers/gemini-session-runner.ts'],
};

let selectedTests: string[] | null = null; // null = run all

if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);

  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, GEMINI_E2E_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
    process.stderr.write(`\nGemini E2E selection (${selection.reason}): ${selection.selected.length}/${Object.keys(GEMINI_E2E_TOUCHFILES).length} tests\n`);
    if (selection.skipped.length > 0) {
      process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
    }
    process.stderr.write('\n');
  }
}

/** Skip an individual test if not selected by diff-based selection. */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test.concurrent : test.skip)(testName, fn, timeout);
}

// --- Eval result collector ---

const evalCollector = evalsEnabled && !SKIP ? new EvalCollector('e2e-gemini') : null;

function recordGeminiE2E(name: string, result: GeminiResult, passed: boolean) {
  evalCollector?.addTest({
    name,
    suite: 'gemini-e2e',
    tier: 'e2e',
    passed,
    duration_ms: result.durationMs,
    cost_usd: 0,
    output: result.output?.slice(0, 2000),
    turns_used: result.toolCalls.length,
    exit_reason: result.exitCode === 0 ? 'success' : `exit_code_${result.exitCode}`,
  });
}

function logGeminiCost(label: string, result: GeminiResult) {
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

describeGemini('Gemini E2E', () => {
  let testWorktree: string;

  beforeAll(() => {
    testWorktree = createTestWorktree('gemini');
  });

  afterAll(() => {
    harvestAndCleanup('gemini');
  });

  testIfSelected('gemini-smoke', async () => {
    // Smoke test: can Gemini start, read the repo, and produce output?
    // Uses a simple prompt that doesn't require skill invocation or complex navigation.
    const result = await runGeminiSkill({
      prompt: 'What is this project? Answer in one sentence based on the README.',
      timeoutMs: JUDGE_MS,
      cwd: testWorktree,
    });

    logGeminiCost('gemini-smoke', result);

    // Pass if Gemini produced any meaningful output (even with non-zero exit from timeout)
    const hasOutput = result.output.length > 10;
    const passed = hasOutput;
    recordGeminiE2E('gemini-smoke', result, passed);

    expect(result.output.length, 'Gemini should produce output').toBeGreaterThan(10);
  }, JUDGE_MS);
});
