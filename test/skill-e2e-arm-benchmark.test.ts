/**
 * WS2 — with-skill vs without-skill agentic arm benchmark (periodic, paid).
 *
 * Role: a standalone RESEARCH INSTRUMENT, not a release gate. gstack skills
 * cost ~13K tokens per invocation and nothing else measures whether they earn
 * it. Each named build-shaped task runs ARM_TRIALS with/without pairs through
 * real `claude -p` sessions on the pinned ARM_MODEL against the same seeded
 * fixture repo — one arm with the behavioral-layer skill installed
 * (project-scope .claude/skills + a CLAUDE.md routing line, the proven
 * opus-47 pattern; `claude -p` does NOT auto-load SKILL.md), one arm with no
 * gstack at all (`claude-opus-5-5#no-gstack` in the preregistration) — and the
 * `git diff` each arm leaves behind is scored. Metric order is
 * diff-quality-first: checks, then the 0-3 over-engineering score, then LOC.
 * Results inform strategy, they do not gate releases — no assertion here
 * compares arm scores. Preregistration: test/fixtures/arm-benchmark/PREREG.md.
 *
 * Scoring (GST-469): the paired judge (test/helpers/arm-pair-judge.ts) sees
 * both diffs of a pair as A and B, in both orders, and a win counts only when
 * both orders agree. It decides only once its calibration (`arm-pair` in
 * scripts/judge-calibration.ts) meets the PREREG bar; until then the
 * per-diff armJudge decides and the paired result is the diagnostic.
 * results.md names the decider and passes `gstack-eval-plan results --check`.
 *
 * Spend: every cell and judge call reserves in <out>/spend.json under
 * ARM_SPEND_CAP_USD before it starts and settles to measured cost after (a
 * call with no reported cost stays charged at its reservation). A refused
 * reservation prints STOP: reason=budget_exhausted, skips the remaining
 * trials and fails the case. <out> is GSTACK_ARM_BENCHMARK_OUT (set it to
 * share one ledger across a staged pilot and full run), else a per-run
 * directory beside the eval store.
 *
 * The skill under test (`build-discipline`) is assembled at runtime from the
 * two behavioral sections WS3/WS7 added — the reuse ladder (## Search Before
 * Building) and the bounded closer (## Voice) — EXTRACTED from a rendered
 * SKILL.md (ship/), never copied whole (CLAUDE.md fixture rule).
 *
 * Failure taxonomy (CEO review finding 2):
 *   - zero-diff arm  -> VALID scored cell (LOC 0, judge scores it "none").
 *   - harvest failure -> cell FAILED, harvest: null recorded.
 *   - wrong model (asked or billed) -> INFRA cell, excluded from aggregates.
 *   - judge output malformed (never re-asked) -> judge_error cell or pair:
 *     excluded from aggregates, surfaced in the run report, never silently
 *     dropped.
 *
 * The harness (tasks, fixtures, skill assembly, arm setup, diff capture,
 * ledger, results.md) lives in test/helpers/arm-benchmark-harness.ts, shared
 * with the FREE selftest at test/arm-benchmark-selftest.test.ts — which runs
 * in `bun run test` on every PR so this paid instrument can never burn money
 * on broken fixtures or plumbing. Everything needing a live model is here,
 * inside the EVALS_TIER=periodic describes.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import {
  runId, selectedTests, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { describeE2ETier } from './helpers/e2e-gate';
import { getProjectEvalDir } from './helpers/eval-store';
import { armJudge, type ArmJudgeScore } from './helpers/llm-judge';
import { armPairJudge, meteredJudgeCall, pairJudgeDecides, type PairVerdict } from './helpers/arm-pair-judge';
import { readLedger, setCap, summarize as spendSummary, renderSpend } from '../lib/spend-ledger';
import {
  ARM_JUDGE_DIFF_CAP, ARM_MODEL, ARM_TRIALS, ARM_SPEND_CAP_USD, ARM_CELL_RESERVE_USD,
  TASK_TEST_TIMEOUT_MS, SKILL_NAME, TASKS,
  setupArm, captureStagedDiff, runChecks, armRunOptions, armCellInfra, billedModels, metered, renderArmResults, ArmBudgetStop,
  type Arm, type ArmTask, type DiffHarvest,
} from './helpers/arm-benchmark-harness';
import * as fs from 'fs';
import * as path from 'path';

const OUT = process.env.GSTACK_ARM_BENCHMARK_OUT || path.join(path.dirname(getProjectEvalDir()), 'arm-benchmark', runId);
const SPEND = path.join(OUT, 'spend.json');
let stopped: string | null = null;

// --- Cell runner + reporting ---

interface CellResult {
  task: string;
  trial: number;
  arm: Arm;
  exitReason: string;
  infra: string | null;
  harvest: DiffHarvest | null;
  harvestError: string | null;
  judge: ArmJudgeScore | null;
  judgeError: string | null;
  /** Deterministic functional-check outcome ('none' = task has no oracle).
   *  Correctness comes before LOC in the metric order — a refusal, a broken
   *  implementation, and working code must be distinguishable in the cells. */
  checks: 'pass' | 'fail' | 'none';
  consulted: boolean;
  costUsd: number | null;
  tokens: number;
  turns: number;
}

interface PairResult {
  task: string;
  trial: number;
  cells: CellResult[];
  /** x = with-skill, y = without-skill. */
  verdict: PairVerdict | null;
  error: string | null;
}

const evalCollector = createEvalCollector('e2e-arm-benchmark');
const allPairs: PairResult[] = [];

function skillConsulted(result: SkillTestResult): boolean {
  return result.toolCalls.some((tc) =>
    (tc.tool === 'Skill' && String((tc.input as { skill?: unknown })?.skill ?? '').includes(SKILL_NAME))
    || JSON.stringify(tc.input ?? {}).includes(`.claude/skills/${SKILL_NAME}`));
}

/** The diff a judge sees. Truncation is loud: a clipped patch can hide the construct being scored. */
function judgeDiff(label: string, patch: string): string {
  if (patch.length > ARM_JUDGE_DIFF_CAP) {
    console.warn(`[arm-benchmark ${label}] judge diff truncated to ${ARM_JUDGE_DIFF_CAP}B of ${patch.length}B — the judgement may miss constructs past the cap.`);
  }
  return patch.slice(0, ARM_JUDGE_DIFF_CAP);
}

async function runArmCell(task: ArmTask, arm: Arm, trial: number): Promise<CellResult> {
  const dirs = setupArm(task, arm);
  try {
    const opts = armRunOptions(task, arm, dirs.dir, trial);
    const attempt = `${opts.testName}:${runId}`;
    const result = await metered(SPEND, attempt, ARM_CELL_RESERVE_USD, ARM_MODEL, async () => {
      const r = await runSkillTest({ ...opts, testName: opts.testName, runId });
      return { value: r, costUsd: r.costEstimate.estimatedCost > 0 ? r.costEstimate.estimatedCost : null };
    });
    logCost(`arm-benchmark ${task.fixture} ${arm} t${trial}`, result);
    const infra = armCellInfra(result.model, billedModels(result.transcript));

    // Harvest taxonomy: a capture failure marks the cell failed with
    // harvest: null recorded — never silently dropped.
    let harvest: DiffHarvest | null = null;
    let harvestError: string | null = null;
    try {
      harvest = captureStagedDiff(dirs.dir, dirs.seedSha);
    } catch (err) {
      harvestError = err instanceof Error ? err.message : String(err);
    }
    const checks = runChecks(task, dirs.dir);

    // Per-diff judge (the no-loss diagnostic, and the decider until the
    // paired judge is calibrated). INFRA cells are not judged.
    let judge: ArmJudgeScore | null = null;
    let judgeError: string | null = null;
    const judgeDiffTruncated = harvest !== null && harvest.patch.length > ARM_JUDGE_DIFF_CAP;
    if (harvest && !infra) {
      try {
        judge = await armJudge(task.ticket, judgeDiff(opts.testName, harvest.patch), { call: meteredJudgeCall(SPEND, attempt) });
      } catch (err) {
        if (err instanceof ArmBudgetStop) throw err;
        judgeError = err instanceof Error ? err.message : String(err);
      }
    }

    const consulted = skillConsulted(result);
    recordE2E(evalCollector, opts.testName, 'Arm Benchmark', result, {
      passed: result.exitReason === 'success' && harvest !== null && !infra,
      harvest: harvest
        ? {
          filesChanged: harvest.filesChanged,
          insertions: harvest.insertions,
          deletions: harvest.deletions,
          net: harvest.net,
        }
        : null,
      judge_scores: judge
        ? { over_engineering: judge.over_engineering, ...(checks !== 'none' ? { checks_pass: checks === 'pass' ? 1 : 0 } : {}) }
        : undefined,
      judge_reasoning: judge
        ? `construct: ${judge.construct} | ${judge.reasoning}${judgeDiffTruncated ? ` | diff truncated to ${ARM_JUDGE_DIFF_CAP}B` : ''}`
        : judgeError ? `judge_error: ${judgeError}` : undefined,
      error: infra ?? harvestError ?? undefined,
    });

    return {
      task: task.key,
      trial,
      arm,
      exitReason: result.exitReason,
      infra,
      harvest,
      harvestError,
      judge,
      judgeError,
      checks,
      consulted,
      costUsd: result.costEstimate.estimatedCost > 0 ? result.costEstimate.estimatedCost : null,
      tokens: result.costEstimate.estimatedTokens,
      turns: result.costEstimate.turnsUsed,
    };
  } finally {
    fs.rmSync(dirs.dir, { recursive: true, force: true });
    fs.rmSync(dirs.originDir, { recursive: true, force: true });
  }
}

/** One trial: both cells concurrently, then the paired judge in both orders. */
async function runPair(task: ArmTask, trial: number): Promise<PairResult> {
  const settled = await Promise.allSettled([runArmCell(task, 'with-skill', trial), runArmCell(task, 'without-skill', trial)]);
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure) throw failure.reason;
  const cells = settled.map((s) => (s as PromiseFulfilledResult<CellResult>).value);
  const [withCell, withoutCell] = cells as [CellResult, CellResult];
  let verdict: PairVerdict | null = null;
  let error: string | null = null;
  if (withCell.harvest && withoutCell.harvest && !withCell.infra && !withoutCell.infra) {
    const label = `${task.key}-pair-t${trial}`;
    try {
      verdict = await armPairJudge(task.ticket, judgeDiff(label, withCell.harvest.patch), judgeDiff(label, withoutCell.harvest.patch),
        { call: meteredJudgeCall(SPEND, `${label}:${runId}`) });
    } catch (err) {
      if (err instanceof ArmBudgetStop) throw err;
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    error = 'not judged: a cell has no harvest or is INFRA';
  }
  const pair = { task: task.key, trial, cells, verdict, error };
  allPairs.push(pair);
  return pair;
}

function cellLine(c: CellResult): string {
  const score = c.infra ? c.infra
    : c.judge ? `${c.judge.over_engineering}/3 (${c.judge.construct})`
    : c.judgeError ? 'judge_error' : 'unscored';
  const loc = c.harvest
    ? `+${c.harvest.insertions}/-${c.harvest.deletions} net ${c.harvest.net} in ${c.harvest.filesChanged} file(s)`
    : `harvest FAILED: ${c.harvestError}`;
  return `  t${c.trial} ${c.arm.padEnd(14)} checks=${c.checks}  per-diff=${score}  loc=${loc}  turns=${c.turns}  `
    + `tokens=${(c.tokens / 1000).toFixed(1)}k  cost=$${(c.costUsd ?? 0).toFixed(2)}  consulted=${c.consulted}`;
}

function pairLine(p: PairResult): string {
  if (!p.verdict) return `  t${p.trial} paired: ${p.error}`;
  const winner = p.verdict.winner === 'x' ? 'with-skill' : p.verdict.winner === 'y' ? 'without-skill' : 'tie';
  return `  t${p.trial} paired: ${winner} (orders: ${p.verdict.orders.map((o) => `${o.order}=${o.preferred}`).join(', ') || 'both empty'}; `
    + `mean over_engineering with=${p.verdict.mean.x.toFixed(1)} without=${p.verdict.mean.y.toFixed(1)})`;
}

function printTaskReport(task: ArmTask, pairs: PairResult[]): void {
  console.log(`\n[arm-benchmark ${task.key}] checks first, then over_engineering, then LOC.`);
  for (const p of pairs) {
    for (const c of p.cells) console.log(cellLine(c));
    console.log(pairLine(p));
  }
}

// --- Paid arm runs (periodic tier) ---

const describePaid = describeE2ETier('periodic');

function describeArmTask(task: ArmTask, fn: () => void) {
  const anySelected = selectedTests === null || selectedTests.includes(task.key);
  (anySelected ? describePaid : describe.skip)(`Arm benchmark: ${task.key}`, fn);
}

for (const task of TASKS) {
  describeArmTask(task, () => {
    test(task.key, async () => {
      fs.mkdirSync(OUT, { recursive: true });
      if (readLedger(SPEND).cap_usd === null) setCap(SPEND, ARM_SPEND_CAP_USD);
      const pairs: PairResult[] = [];
      for (let trial = 1; trial <= ARM_TRIALS && !stopped; trial++) {
        try {
          pairs.push(await runPair(task, trial));
        } catch (err) {
          if (!(err instanceof ArmBudgetStop)) throw err;
          stopped = err.message;
          process.stderr.write(err.message + '\n');
        }
      }
      printTaskReport(task, pairs);

      // Harness mechanics only, per arm and trial. Score direction is
      // deliberately unasserted: this is a research instrument.
      expect(stopped, `arm benchmark stopped: ${stopped}`).toBeNull();
      for (const c of pairs.flatMap((p) => p.cells)) {
        const who = `${c.arm} trial ${c.trial}`;
        expect(c.exitReason, `${who} did not finish cleanly`).toBe('success');
        expect(c.harvest, `${who} harvest failed: ${c.harvestError}`).not.toBeNull();
        // The A/B is vacuous unless the skill arm consulted the skill and the
        // no-gstack arm could not have.
        if (c.arm === 'with-skill') expect(c.consulted, `${who} never consulted ${SKILL_NAME} — vacuous comparison`).toBe(true);
        else expect(c.consulted, `${who} references the skill it should not have`).toBe(false);
      }
    }, TASK_TEST_TIMEOUT_MS);
  });
}

afterAll(async () => {
  if (allPairs.length > 0) {
    const decider = pairJudgeDecides();
    const results = renderArmResults({
      runId,
      decider: decider.decides ? `paired (${decider.reason})` : `per-diff (${decider.reason})`,
      cells: allPairs.flatMap((p) => p.cells).map((c) => ({
        task: c.task, trial: c.trial, arm: c.arm, infra: c.infra, checks: c.checks,
        perDiff: c.judge?.over_engineering ?? null, judgeError: c.judgeError !== null, costUsd: c.costUsd,
      })),
      pairs: allPairs.map((p) => ({
        task: p.task,
        trial: p.trial,
        winner: !p.verdict ? null : p.verdict.winner === 'x' ? 'with-skill' : p.verdict.winner === 'y' ? 'without-skill' : 'tie',
        mean: p.verdict ? { 'with-skill': p.verdict.mean.x, 'without-skill': p.verdict.mean.y } : null,
      })),
    });
    fs.writeFileSync(path.join(OUT, 'results.md'), results);
    console.log('\n[arm-benchmark aggregate] research instrument — informs strategy, gates nothing.');
    console.log(results);
    console.log('  ' + renderSpend(spendSummary(readLedger(SPEND))));
    console.log(`  results: ${path.join(OUT, 'results.md')} (check with gstack-eval-plan results --check test/fixtures/arm-benchmark/PREREG.md <results.md>)`);
  }
  await finalizeEvalCollector(evalCollector);
});
