/**
 * Shared helpers for E2E test files.
 *
 * Extracted from the (since-deleted) pre-split monolith to support
 * splitting tests across multiple skill-e2e-*.test.ts files by category.
 */

import '../../lib/conductor-env-shim';
import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import type { SkillTestResult } from './session-runner';
import { EvalCollector, judgePassed } from './eval-store';
import type { EvalTestEntry } from './eval-store';
import { judgeRecommendation, type RecommendationScore } from './llm-judge';
import { selectTests, detectBaseBranch, getChangedFiles, E2E_TOUCHFILES, E2E_TIERS, GLOBAL_TOUCHFILES } from './touchfiles';
import { WorktreeManager } from '../../lib/worktree';
import type { HarvestResult } from '../../lib/worktree';
import { spawnSync } from 'child_process';
import { preflightAnthropicApi } from './anthropic-preflight';
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

/**
 * Compute the diff-based selection for a touchfiles table. Returns null for
 * "run all" (EVALS off, EVALS_ALL=1, or no diff vs the base branch — e.g. on
 * main). Shared by this module (E2E_TOUCHFILES) and skill-llm-eval.test.ts
 * (LLM_JUDGE_TOUCHFILES) so the selection logic exists exactly once.
 */
export function computeDiffSelection(
  touchfiles: Record<string, string[]>,
  label: string,
): string[] | null {
  if (!evalsEnabled || process.env.EVALS_ALL) return null;
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);
  // If changedFiles is empty (e.g., on main branch), run all
  if (changedFiles.length === 0) return null;

  const selection = selectTests(changedFiles, touchfiles, GLOBAL_TOUCHFILES);
  process.stderr.write(`\n${label} selection (${selection.reason}): ${selection.selected.length}/${Object.keys(touchfiles).length} tests\n`);
  if (selection.skipped.length > 0) {
    process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
  }
  process.stderr.write('\n');
  return selection.selected;
}

/**
 * Parse the sharded paid runner's precomputed selection (EVALS_SELECTION_JSON,
 * written by serializePaidDiffSelection in scripts/test-paid-shards.ts).
 * Returns { selected: null } for run-all. THROWS on any parse/shape failure —
 * resolveModuleSelection turns that into a fail-open local recompute.
 */
export function parseEvalsSelectionJson(raw: string): { selected: string[] | null; reason: string } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  const { selected, reason } = parsed as { selected?: unknown; reason?: unknown };
  if (selected !== null
    && !(Array.isArray(selected) && selected.every((s) => typeof s === 'string'))) {
    throw new Error('selected must be null or string[]');
  }
  return {
    selected: selected as string[] | null,
    reason: typeof reason === 'string' ? reason : 'parent selection',
  };
}

/**
 * Resolve the module-load E2E selection: prefer the parent shard runner's
 * EVALS_SELECTION_JSON — skipping this module's own git walk and, when
 * touchfiles-data.ts is in the diff, the per-child bun subprocess that
 * evaluates the old data file (test-selection.ts map-diff path, one per
 * shard). On ANY parse/shape failure, fall back to computing locally
 * (fail-open preserved) with one stderr warning.
 */
export function resolveModuleSelection(
  raw: string | undefined,
  compute: () => string[] | null,
  stderrWrite: (text: string) => void = (text) => process.stderr.write(text),
): string[] | null {
  if (raw) {
    try {
      const { selected, reason } = parseEvalsSelectionJson(raw);
      stderrWrite(`\nE2E selection (parent-propagated: ${reason}): ${selected === null ? 'all' : selected.length} tests\n`);
      return selected;
    } catch (err) {
      stderrWrite(`WARNING: malformed EVALS_SELECTION_JSON (${err instanceof Error ? err.message : String(err)}) — falling back to local selection\n`);
    }
  }
  return compute();
}

export let selectedTests: string[] | null = resolveModuleSelection(
  evalsEnabled ? process.env.EVALS_SELECTION_JSON : undefined,
  () => computeDiffSelection(E2E_TOUCHFILES, 'E2E'),
); // null = run all

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

/**
 * Wrap a describe block to skip entirely if none of its tests are selected.
 * `selected` defaults to this module's E2E selection (diff + EVALS_TIER);
 * pass an explicit selection (e.g. computeDiffSelection over
 * LLM_JUDGE_TOUCHFILES) to reuse the gating against a different table.
 */
export function describeIfSelected(name: string, testNames: string[], fn: () => void, selected: string[] | null = selectedTests) {
  const anySelected = selected === null || testNames.some(t => selected.includes(t));
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
    tokens_used: result.costEstimate.estimatedTokens,
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

/**
 * Threshold for `reason_substance` (1-5 rubric) above which a recommendation
 * is considered substantive enough to ship. 4 = "concrete and option-specific";
 * 3 = generic ("because it's faster"). We want to catch generic. If Haiku
 * flakes at this bar in practice, lower the threshold rather than weakening
 * the gate (per design plan).
 */
export const RECOMMENDATION_SUBSTANCE_THRESHOLD = 4;

/**
 * Run judgeRecommendation on a captured AskUserQuestion text, record the score
 * into the eval collector, and assert all four quality dimensions. Replaces a
 * 22-line block previously duplicated across every E2E test that captures an
 * AskUserQuestion. Returns the score for tests that want to inspect it
 * further.
 */
export async function assertRecommendationQuality(opts: {
  captured: string;
  evalCollector: EvalCollector | null;
  evalId: string;
  evalTitle: string;
  result: SkillTestResult;
  passed: boolean;
}): Promise<RecommendationScore> {
  const recScore = await judgeRecommendation(opts.captured);
  recordE2E(opts.evalCollector, opts.evalId, opts.evalTitle, opts.result, {
    passed: opts.passed,
    judge_scores: {
      rec_present: recScore.present ? 1 : 0,
      rec_commits: recScore.commits ? 1 : 0,
      rec_has_because: recScore.has_because ? 1 : 0,
      rec_substance: recScore.reason_substance,
    },
    judge_reasoning: `${recScore.reasoning} | reason: "${recScore.reason_text}"`,
  });
  expect(recScore.present, recScore.reasoning).toBe(true);
  expect(recScore.commits, recScore.reasoning).toBe(true);
  expect(recScore.has_because, recScore.reasoning).toBe(true);
  expect(
    recScore.reason_substance,
    `${recScore.reasoning}\n  reason: "${recScore.reason_text}"`,
  ).toBeGreaterThanOrEqual(RECOMMENDATION_SUBSTANCE_THRESHOLD);
  return recScore;
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
// NOTE: since gstack-skill-start honors GSTACK_HOME (EOV7), hermetic children read the
// temp GSTACK_HOME that hermetic-env.ts seeds (the canonical marker list lives there);
// this operator-HOME seeding only serves EVALS_HERMETIC=0 debug runs.
if (evalsEnabled) {
  const gstackDir = path.join(os.homedir(), '.gstack');
  fs.mkdirSync(gstackDir, { recursive: true });
  // Marker list kept at parity with hermetic-env.ts's child-GSTACK_HOME seed
  // (the canonical set for the emission layer's gates).
  for (const f of [
    '.activated',
    '.completeness-intro-seen',
    '.telemetry-prompted',
    '.proactive-prompted',
    '.first-loop-tip-shown',
    '.feature-prompted-continuous-checkpoint',
    '.feature-prompted-model-overlay',
  ]) {
    const p = path.join(gstackDir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
}

// Fail fast if Anthropic API is unreachable — don't burn through tests getting
// ConnectionRefused. The sharded paid runner pings once in the parent and sets
// EVALS_PREFLIGHT_OK=1 for its children, so per-file module loads skip this
// (was: ~30 paid pings per full sharded run, one per importing file).
if (evalsEnabled) {
  preflightAnthropicApi();
}

/** Skip an individual test if not selected (for multi-test describe blocks). */
export function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number, selected: string[] | null = selectedTests) {
  const shouldRun = selected === null || selected.includes(testName);
  (shouldRun ? test : test.skip)(testName, fn, timeout);
}

/** Concurrent version — runs in parallel with other concurrent tests within the same describe block. */
export function testConcurrentIfSelected(testName: string, fn: () => Promise<void>, timeout: number, selected: string[] | null = selectedTests) {
  const shouldRun = selected === null || selected.includes(testName);
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
