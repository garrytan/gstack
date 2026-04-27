/**
 * Tool-budget regression test (gate, free).
 *
 * Asserts: no test in the most recent eval run grew its tool calls or
 * turns by more than 2× vs the prior recorded run. Pure library — does
 * not spawn `claude` or pay any API cost. Reads the project eval dir
 * (~/.gstack/projects/<slug>/evals/) and compares the latest run against
 * its predecessor.
 *
 * First-run grace: if there's no prior run, the test passes vacuously.
 * The purpose is to catch a SECOND-run regression — a real-world scenario
 * is "preamble change shipped, /qa eval went from 30 tool calls to 90".
 *
 * Why two metrics (tools and turns): a regression that adds tool calls
 * usually reflects an inefficient skill prompt; a regression that adds
 * turns reflects a skill that is hesitating or losing track. Either is
 * worth catching. We use a noise floor (5 tool calls / 3 turns) to
 * avoid flagging tests that started tiny and got slightly bigger.
 *
 * Override: GSTACK_BUDGET_RATIO=<n> (default 2.0).
 *
 * Skipping: only the gate-level CI-blocking variant runs in EVALS_TIER=gate.
 * The same logic runs anywhere `bun test` is invoked because comparison
 * is free — no LLM cost.
 */

import { describe, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  getProjectEvalDir,
  findPreviousRun,
  compareEvalResults,
  assertNoBudgetRegression,
  type EvalResult,
} from './helpers/eval-store';

function currentGitBranch(): string {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: 'pipe', timeout: 3000,
    });
    return result.stdout?.toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

interface LatestRun {
  filepath: string;
  result: EvalResult;
}

/** Find the most recent finalized (non-_partial) eval file for a tier. */
function findLatestRun(evalDir: string, tier: 'e2e' | 'llm-judge'): LatestRun | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(evalDir);
  } catch {
    return null;
  }
  const candidates: Array<{ filepath: string; timestamp: string }> = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    if (f.startsWith('_partial')) continue;
    const fullPath = path.join(evalDir, f);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as EvalResult;
      if (data.tier !== tier) continue;
      candidates.push({ filepath: fullPath, timestamp: data.timestamp ?? '' });
    } catch { /* ignore corrupt */ }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const top = candidates[0]!;
  return {
    filepath: top.filepath,
    result: JSON.parse(fs.readFileSync(top.filepath, 'utf-8')) as EvalResult,
  };
}

function checkTier(tier: 'e2e' | 'llm-judge'): void {
  const evalDir = getProjectEvalDir();
  const latest = findLatestRun(evalDir, tier);
  if (!latest) {
    // eslint-disable-next-line no-console
    console.log(`[budget-regression:${tier}] no current run in ${evalDir} — skipping`);
    return;
  }
  // Branch alignment: only assert when the latest eval was actually
  // produced by THIS checkout's branch. Cross-branch comparison would
  // measure noise from unrelated work. Pre-existing eval history from
  // other branches is not our regression to fix.
  const myBranch = currentGitBranch();
  if (latest.result.branch !== myBranch) {
    // eslint-disable-next-line no-console
    console.log(
      `[budget-regression:${tier}] latest eval is from "${latest.result.branch}" ` +
      `but current branch is "${myBranch}" — skipping (run evals on this branch first)`,
    );
    return;
  }
  const branch = latest.result.branch;
  const priorPath = findPreviousRun(evalDir, tier, branch, latest.filepath);
  if (!priorPath) {
    // eslint-disable-next-line no-console
    console.log(`[budget-regression:${tier}] no prior run found — first-run grace`);
    return;
  }
  let prior: EvalResult;
  try {
    prior = JSON.parse(fs.readFileSync(priorPath, 'utf-8')) as EvalResult;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[budget-regression:${tier}] could not read prior ${priorPath}: ${(err as Error).message}`);
    return;
  }
  // Branch-scoped: only compare same-branch history. Cross-branch
  // comparison is noisy (different branches do different work). If
  // findPreviousRun fell back to another branch, treat as no prior.
  if (prior.branch !== branch) {
    // eslint-disable-next-line no-console
    console.log(
      `[budget-regression:${tier}] no same-branch prior (latest on "${branch}", prior on "${prior.branch}") — skipping`,
    );
    return;
  }
  const comparison = compareEvalResults(prior, latest.result, priorPath, latest.filepath);
  // Throws on regression.
  assertNoBudgetRegression(comparison);
  // eslint-disable-next-line no-console
  console.log(
    `[budget-regression:${tier}] OK — ${comparison.deltas.length} test(s) compared, ` +
    `${comparison.tool_count_before}→${comparison.tool_count_after} tools, ` +
    `cost Δ $${comparison.total_cost_delta.toFixed(2)}`,
  );
}

describe('tool budget regression (gate, free)', () => {
  test('no e2e test exceeds 2× prior tool calls or turns', () => {
    checkTier('e2e');
  });

  test('no llm-judge test exceeds 2× prior tool calls or turns', () => {
    checkTier('llm-judge');
  });
});
