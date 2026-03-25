/**
 * Shared helpers for E2E test files.
 *
 * Extracted from the monolithic skill-e2e.test.ts to support splitting
 * tests across multiple files by category.
 */

import { describe, test, beforeAll, afterAll } from 'bun:test';
import type { SkillTestResult } from './session-runner';
import { EvalCollector, judgePassed } from './eval-store';
import type { EvalTestEntry } from './eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, E2E_TOUCHFILES, E2E_TIERS, GLOBAL_TOUCHFILES } from './touchfiles';
import { WorktreeManager } from '../../lib/worktree';
import type { HarvestResult } from '../../lib/worktree';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const ROOT = path.resolve(import.meta.dir, '..', '..');

// Skip unless EVALS=1. Session runner strips CLAUDE* env vars to avoid nested session issues.
//
// BLAME PROTOCOL: When an eval fails, do NOT claim "pre-existing" or "not related
// to our changes" without proof. Run the same eval on main to verify. These tests
// have invisible couplings — preamble text, SKILL.md content, and timing all affect
// agent behavior. See CLAUDE.md "E2E eval failure blame protocol" for details.
export const evalsEnabled = !!process.env.EVALS;

// --- Diff-based test selection ---
// When EVALS_ALL is not set, only run tests whose touchfiles were modified.
// Set EVALS_ALL=1 to force all tests. Set EVALS_BASE to override base branch.
export let selectedTests: string[] | null = null; // null = run all

if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);

  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
    process.stderr.write(`\nE2E selection (${selection.reason}): ${selection.selected.length}/${Object.keys(E2E_TOUCHFILES).length} tests\n`);
    if (selection.skipped.length > 0) {
      process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
    }
    process.stderr.write('\n');
  }
  // If changedFiles is empty (e.g., on main branch), selectedTests stays null → run all
}

// EVALS_TIER: filter tests by tier after diff-based selection.
// 'gate' = gate tests only (CI default — blocks merge)
// 'periodic' = periodic tests only (weekly cron / manual)
// not set = run all selected tests (local dev default, backward compat)
if (evalsEnabled && process.env.EVALS_TIER) {
  const tier = process.env.EVALS_TIER as 'gate' | 'periodic';
  const tierTests = Object.entries(E2E_TIERS)
    .filter(([, t]) => t === tier)
    .map(([name]) => name);

  if (selectedTests === null) {
    selectedTests = tierTests;
  } else {
    selectedTests = selectedTests.filter(t => tierTests.includes(t));
  }
  process.stderr.write(`EVALS_TIER=${tier}: ${selectedTests.length} tests\n\n`);
}

export const describeE2E = evalsEnabled ? describe : describe.skip;

/** Wrap a describe block to skip entirely if none of its tests are selected. */
export function describeIfSelected(name: string, testNames: string[], fn: () => void) {
  const anySelected = selectedTests === null || testNames.some(t => selectedTests!.includes(t));
  (anySelected ? describeE2E : describe.skip)(name, fn);
}

// Unique run ID for this E2E session — used for heartbeat + per-run log directory
export const runId = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);

export const browseBin = path.resolve(ROOT, 'browse', 'dist', 'browse');

// Check if Anthropic API key is available (needed for outcome evals)
export const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

/**
 * Copy a directory tree recursively (files only, follows structure).
 */
export function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Set up browse shims (binary symlink, find-browse, remote-slug) in a tmpDir.
 */
export function setupBrowseShims(dir: string) {
  // Symlink browse binary
  const binDir = path.join(dir, 'browse', 'dist');
  fs.mkdirSync(binDir, { recursive: true });
  if (fs.existsSync(browseBin)) {
    fs.symlinkSync(browseBin, path.join(binDir, 'browse'));
  }

  // find-browse shim
  const findBrowseDir = path.join(dir, 'browse', 'bin');
  fs.mkdirSync(findBrowseDir, { recursive: true });
  fs.writeFileSync(
    path.join(findBrowseDir, 'find-browse'),
    `#!/bin/bash\necho "${browseBin}"\n`,
    { mode: 0o755 },
  );

  // remote-slug shim (returns test-project)
  fs.writeFileSync(
    path.join(findBrowseDir, 'remote-slug'),
    `#!/bin/bash\necho "test-project"\n`,
    { mode: 0o755 },
  );
}

/**
 * Print cost summary after an E2E test.
 */
export function logCost(label: string, result: { costEstimate: { turnsUsed: number; estimatedTokens: number; estimatedCost: number }; duration: number }) {
  const { turnsUsed, estimatedTokens, estimatedCost } = result.costEstimate;
  const durationSec = Math.round(result.duration / 1000);
  console.log(`${label}: $${estimatedCost.toFixed(2)} (${turnsUsed} turns, ${(estimatedTokens / 1000).toFixed(1)}k tokens, ${durationSec}s)`);
}

/**
 * Dump diagnostic info on planted-bug outcome failure (decision 1C).
 */
export function dumpOutcomeDiagnostic(dir: string, label: string, report: string, judgeResult: any) {
  try {
    const transcriptDir = path.join(dir, '.gstack', 'test-transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(transcriptDir, `${label}-outcome-${timestamp}.json`),
      JSON.stringify({ label, report, judgeResult }, null, 2),
    );
  } catch { /* non-fatal */ }
}

/**
 * Create an EvalCollector for a specific suite. Returns null if evals are not enabled.
 */
export function createEvalCollector(suite: string): EvalCollector | null {
  return evalsEnabled ? new EvalCollector(suite) : null;
}

/** DRY helper to record an E2E test result into the eval collector. */
export function recordE2E(
  evalCollector: EvalCollector | null,
  name: string,
  suite: string,
  result: SkillTestResult,
  extra?: Partial<EvalTestEntry>,
) {
  // Derive last tool call from transcript for machine-readable diagnostics
  const lastTool = result.toolCalls.length > 0
    ? `${result.toolCalls[result.toolCalls.length - 1].tool}(${JSON.stringify(result.toolCalls[result.toolCalls.length - 1].input).slice(0, 60)})`
    : undefined;

  evalCollector?.addTest({
    name, suite, tier: 'e2e',
    passed: result.exitReason === 'success' && result.browseErrors.length === 0,
    duration_ms: result.duration,
    cost_usd: result.costEstimate.estimatedCost,
    transcript: result.transcript,
    output: result.output?.slice(0, 2000),
    turns_used: result.costEstimate.turnsUsed,
    browse_errors: result.browseErrors,
    exit_reason: result.exitReason,
    timeout_at_turn: result.exitReason === 'timeout' ? result.costEstimate.turnsUsed : undefined,
    last_tool_call: lastTool,
    model: result.model,
    first_response_ms: result.firstResponseMs,
    max_inter_turn_ms: result.maxInterTurnMs,
    ...extra,
  });
}

/** Finalize an eval collector (write results). */
export async function finalizeEvalCollector(evalCollector: EvalCollector | null) {
  if (evalCollector) {
    try {
      await evalCollector.finalize();
    } catch (err) {
      console.error('Failed to save eval results:', err);
    }
  }
}

// Pre-seed preamble state files so E2E tests don't waste turns on lake intro + telemetry prompts.
// These are one-time interactive prompts that burn 3-7 turns per test if not pre-seeded.
if (evalsEnabled) {
  const gstackDir = path.join(os.homedir(), '.gstack');
  fs.mkdirSync(gstackDir, { recursive: true });
  for (const f of ['.completeness-intro-seen', '.telemetry-prompted']) {
    const p = path.join(gstackDir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
}

// Fail fast if Anthropic API is unreachable — don't burn through tests getting ConnectionRefused
if (evalsEnabled) {
  const check = spawnSync('sh', ['-c', 'echo "ping" | claude -p --max-turns 1 --output-format stream-json --verbose --dangerously-skip-permissions'], {
    stdio: 'pipe', timeout: 30_000,
  });
  const output = check.stdout?.toString() || '';
  if (output.includes('ConnectionRefused') || output.includes('Unable to connect')) {
    throw new Error('Anthropic API unreachable — aborting E2E suite. Fix connectivity and retry.');
  }
}

/** Skip an individual test if not selected (for multi-test describe blocks). */
export function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test : test.skip)(testName, fn, timeout);
}

/** Concurrent version — runs in parallel with other concurrent tests within the same describe block. */
export function testConcurrentIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test.concurrent : test.skip)(testName, fn, timeout);
}

// --- Worktree isolation ---

let worktreeManager: WorktreeManager | null = null;

export function getWorktreeManager(): WorktreeManager {
  if (!worktreeManager) {
    worktreeManager = new WorktreeManager();
    worktreeManager.pruneStale();
  }
  return worktreeManager;
}

/** Create an isolated worktree for a test. Returns the worktree path. */
export function createTestWorktree(testName: string): string {
  return getWorktreeManager().create(testName);
}

/** Harvest changes and clean up. Call in afterAll(). Returns HarvestResult for eval integration. */
export function harvestAndCleanup(testName: string): HarvestResult | null {
  const mgr = getWorktreeManager();
  const result = mgr.harvest(testName);
  if (result) {
    if (result.isDuplicate) {
      process.stderr.write(`\n  HARVEST [${testName}]: duplicate patch (skipped)\n`);
    } else {
      process.stderr.write(`\n  HARVEST [${testName}]: ${result.changedFiles.length} files changed\n`);
      process.stderr.write(`  Patch: ${result.patchPath}\n`);
      process.stderr.write(`  ${result.diffStat}\n\n`);
    }
  }
  mgr.cleanup(testName);
  return result;
}

/**
 * Convenience: describe block with automatic worktree isolation + harvest.
 * Any test file can use this to get real repo context instead of a tmpdir.
 * Note: tests with planted-bug fixtures should NOT use this — they need their fixture repos.
 */
export function describeWithWorktree(
  name: string,
  testNames: string[],
  fn: (getWorktreePath: () => string) => void,
) {
  describeIfSelected(name, testNames, () => {
    let worktreePath: string;
    beforeAll(() => { worktreePath = createTestWorktree(name); });
    afterAll(() => { harvestAndCleanup(name); });
    fn(() => worktreePath);
  });
}

export { judgePassed } from './eval-store';
export { EvalCollector } from './eval-store';
export type { EvalTestEntry } from './eval-store';
export type { HarvestResult } from '../../lib/worktree';
