/**
 * Gemini CLI E2E tests — verify skills work when invoked by Gemini CLI.
 *
 * Spawns `gemini -p` with stream-json output in the repo root (where
 * .agents/skills/ already exists), parses JSONL events, and validates
 * structured results. Follows the same pattern as codex-e2e.test.ts.
 *
 * Prerequisites:
 * - `gemini` binary installed (npm install -g @google/gemini-cli)
 * - Gemini authenticated via ~/.gemini/ config or GEMINI_API_KEY env var
 * - EVALS=1 env var set (same gate as Claude E2E tests)
 *
 * Skips gracefully when prerequisites are not met.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { runGeminiSkill } from './helpers/gemini-session-runner';
import type { GeminiResult } from './helpers/gemini-session-runner';
import { EvalCollector } from './helpers/eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// --- Prerequisites check ---

const GEMINI_AVAILABLE = (() => {
  try {
    const result = Bun.spawnSync(['which', 'gemini']);
    return result.exitCode === 0;
  } catch { return false; }
})();

const evalsEnabled = !!process.env.EVALS;

// Skip all tests if gemini is not available or EVALS is not set.
const SKIP = !GEMINI_AVAILABLE || !evalsEnabled;

const describeGemini = SKIP ? describe.skip : describe;

// Log why we're skipping (helpful for debugging CI)
if (!evalsEnabled) {
  // Silent — same as Claude E2E tests, EVALS=1 required
} else if (!GEMINI_AVAILABLE) {
  process.stderr.write('\nGemini E2E: SKIPPED — gemini binary not found (install: npm i -g @google/gemini-cli)\n');
}

// --- Diff-based test selection ---

// Gemini E2E touchfiles — keyed by test name, same pattern as Codex E2E
const GEMINI_E2E_TOUCHFILES: Record<string, string[]> = {
  'gemini-discover-skill':  ['.agents/skills/**', 'test/helpers/gemini-session-runner.ts'],
  'gemini-review-findings': ['review/**', '.agents/skills/gstack-review/**', 'test/helpers/gemini-session-runner.ts'],
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
  // If changedFiles is empty (e.g., on main branch), selectedTests stays null -> run all
}

/** Skip an individual test if not selected by diff-based selection. */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test : test.skip)(testName, fn, timeout);
}

// --- Eval result collector ---

const evalCollector = evalsEnabled && !SKIP ? new EvalCollector('e2e-gemini') : null;

/** DRY helper to record a Gemini E2E test result into the eval collector. */
function recordGeminiE2E(name: string, result: GeminiResult, passed: boolean) {
  evalCollector?.addTest({
    name,
    suite: 'gemini-e2e',
    tier: 'e2e',
    passed,
    duration_ms: result.durationMs,
    cost_usd: 0, // Gemini doesn't report cost in USD; tokens are tracked
    output: result.output?.slice(0, 2000),
    turns_used: result.toolCalls.length, // approximate: tool calls as turns
    exit_reason: result.exitCode === 0 ? 'success' : `exit_code_${result.exitCode}`,
  });
}

/** Print cost summary after a Gemini E2E test. */
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

  testIfSelected('gemini-discover-skill', async () => {
    // Run Gemini in the repo root where .agents/skills/ exists
    const result = await runGeminiSkill({
      prompt: 'List any skills or instructions you have available. Just list the names.',
      timeoutMs: 60_000,
      cwd: ROOT,
    });

    logGeminiCost('gemini-discover-skill', result);

    // Gemini should have produced some output
    const passed = result.exitCode === 0 && result.output.length > 0;
    recordGeminiE2E('gemini-discover-skill', result, passed);

    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
    // The output should reference skills in some form
    const outputLower = result.output.toLowerCase();
    expect(
      outputLower.includes('review') || outputLower.includes('gstack') || outputLower.includes('skill'),
    ).toBe(true);
  }, 120_000);

  testIfSelected('gemini-review-findings', async () => {
    // Run gstack-review skill via Gemini on this repo
    const result = await runGeminiSkill({
      prompt: 'Run the gstack-review skill on this repository. Review the current branch diff and report your findings.',
      timeoutMs: 540_000,
      cwd: ROOT,
    });

    logGeminiCost('gemini-review-findings', result);

    // Should produce structured review-like output
    const output = result.output;
    const passed = result.exitCode === 0 && output.length > 50;
    recordGeminiE2E('gemini-review-findings', result, passed);

    expect(result.exitCode).toBe(0);
    expect(output.length).toBeGreaterThan(50);

    // Review output should contain some review-like content
    const outputLower = output.toLowerCase();
    const hasReviewContent =
      outputLower.includes('finding') ||
      outputLower.includes('issue') ||
      outputLower.includes('review') ||
      outputLower.includes('change') ||
      outputLower.includes('diff') ||
      outputLower.includes('clean') ||
      outputLower.includes('no issues') ||
      outputLower.includes('p1') ||
      outputLower.includes('p2');
    expect(hasReviewContent).toBe(true);
  }, 600_000);
});
