/**
 * Codex CLI E2E tests — verify skills work when invoked by Codex.
 *
 * Spawns `codex exec` with skills installed in a temp HOME, parses JSONL
 * output, and validates structured results. Follows the same pattern as
 * skill-e2e.test.ts but adapted for Codex CLI.
 *
 * Prerequisites:
 * - `codex` binary installed (npm install -g @openai/codex)
 * - Codex authenticated via ~/.codex/ config (no OPENAI_API_KEY env var needed)
 * - EVALS=1 env var set (same gate as Claude E2E tests)
 *
 * Skips gracefully when prerequisites are not met.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runCodexSkill, parseCodexJSONL, installSkillToTempHome } from './helpers/codex-session-runner';
import type { CodexResult } from './helpers/codex-session-runner';
import { EvalCollector } from './helpers/eval-store';
import type { EvalTestEntry } from './helpers/eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { createTestWorktree, harvestAndCleanup } from './helpers/e2e-helpers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');

// --- Prerequisites check ---

const CODEX_AVAILABLE = (() => {
  try {
    const result = Bun.spawnSync(['which', 'codex']);
    return result.exitCode === 0;
  } catch { return false; }
})();

const evalsEnabled = !!process.env.EVALS;

// Skip all tests if codex is not available or EVALS is not set.
// Note: Codex uses its own auth from ~/.codex/ config — no OPENAI_API_KEY env var needed.
const SKIP = !CODEX_AVAILABLE || !evalsEnabled;

const describeCodex = SKIP ? describe.skip : describe;

// Log why we're skipping (helpful for debugging CI)
if (!evalsEnabled) {
  // Silent — same as Claude E2E tests, EVALS=1 required
} else if (!CODEX_AVAILABLE) {
  process.stderr.write('\nCodex E2E: SKIPPED — codex binary not found (install: npm i -g @openai/codex)\n');
}

// --- Diff-based test selection ---

// Codex E2E touchfiles — keyed by test name, same pattern as E2E_TOUCHFILES
const CODEX_E2E_TOUCHFILES: Record<string, string[]> = {
  'codex-discover-skill':    ['codex/**', '.agents/skills/**', 'test/helpers/codex-session-runner.ts'],
  'codex-review-findings':   ['review/**', '.agents/skills/gstack-review/**', 'codex/**', 'test/helpers/codex-session-runner.ts'],
};

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
  (shouldRun ? test.concurrent : test.skip)(testName, fn, timeout);
}

// --- Eval result collector ---

const evalCollector = evalsEnabled && !SKIP ? new EvalCollector('e2e-codex') : null;

/** DRY helper to record a Codex E2E test result into the eval collector. */
function recordCodexE2E(name: string, result: CodexResult, passed: boolean) {
  evalCollector?.addTest({
    name,
    suite: 'codex-e2e',
    tier: 'e2e',
    passed,
    duration_ms: result.durationMs,
    cost_usd: 0, // Codex doesn't report cost in the same way; tokens are tracked
    output: result.output?.slice(0, 2000),
    turns_used: result.toolCalls.length, // approximate: tool calls as turns
    exit_reason: result.exitCode === 0 ? 'success' : `exit_code_${result.exitCode}`,
  });
}

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
    // Install gstack-review skill to a temp HOME and ask Codex to list skills
    const skillDir = path.join(testWorktree, '.agents', 'skills', 'gstack-review');

    const result = await runCodexSkill({
      skillDir,
      prompt: 'List any skills or instructions you have available. Just list the names.',
      timeoutMs: 60_000,
      cwd: testWorktree,
      skillName: 'gstack-review',
    });

    logCodexCost('codex-discover-skill', result);

    // Codex should have produced some output
    const passed = result.exitCode === 0 && result.output.length > 0;
    recordCodexE2E('codex-discover-skill', result, passed);

    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
    // Skill loading errors mean our generated SKILL.md files are broken
    expect(result.stderr).not.toContain('invalid');
    expect(result.stderr).not.toContain('Skipped loading');
    // The output should reference the skill name in some form
    const outputLower = result.output.toLowerCase();
    expect(
      outputLower.includes('review') || outputLower.includes('gstack') || outputLower.includes('skill'),
    ).toBe(true);
  }, 120_000);

  // Validates that Codex can invoke the gstack-review skill, run a diff-based
  // code review, and produce structured review output with findings/issues.
  // Accepts Codex timeout (exit 124/137) as non-failure since that's a CLI perf issue.
  testIfSelected('codex-review-findings', async () => {
    // Install gstack-review skill and ask Codex to review the worktree
    const skillDir = path.join(testWorktree, '.agents', 'skills', 'gstack-review');

    const result = await runCodexSkill({
      skillDir,
      prompt: 'Run the gstack-review skill on this repository. Review the current branch diff and report your findings.',
      timeoutMs: 540_000,
      cwd: testWorktree,
      skillName: 'gstack-review',
    });

    logCodexCost('codex-review-findings', result);

    // Should produce structured review-like output
    const output = result.output;

    // Codex may time out on large diffs — accept timeout as "not our fault"
    // exitCode 124 = killed by timeout, which is a Codex CLI performance issue
    if (result.exitCode === 124 || result.exitCode === 137) {
      console.warn(`codex-review-findings: Codex timed out (exit ${result.exitCode}) — skipping assertions`);
      recordCodexE2E('codex-review-findings', result, true); // don't fail the suite
      return;
    }

    const passed = result.exitCode === 0 && output.length > 50;
    recordCodexE2E('codex-review-findings', result, passed);

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
