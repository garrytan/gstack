/**
 * WS2 — with-skill vs without-skill agentic arm benchmark (periodic, paid).
 *
 * Role: a standalone RESEARCH INSTRUMENT, not a release gate. gstack skills
 * cost ~13K tokens per invocation and nothing else measures whether they earn
 * it. Each named build-shaped task runs twice through real `claude -p`
 * sessions against the same seeded fixture repo — one arm with the
 * behavioral-layer skill installed (project-scope .claude/skills + a
 * CLAUDE.md routing line, the proven opus-47 pattern; `claude -p` does NOT
 * auto-load SKILL.md), one arm without — and the `git diff` each arm leaves
 * behind is scored. Metric order is diff-quality-first: the 0-3
 * over-engineering judge score is reported before LOC. Expect uncomfortable
 * numbers sometimes; that is the point. Results inform strategy, they do not
 * gate releases — no assertion here compares arm scores.
 *
 * The skill under test (`build-discipline`) is assembled at runtime from the
 * two behavioral sections WS3/WS7 added — the reuse ladder (## Search Before
 * Building) and the bounded closer (## Voice) — EXTRACTED from a rendered
 * SKILL.md (ship/), never copied whole (CLAUDE.md fixture rule).
 *
 * Failure taxonomy (CEO review finding 2):
 *   - zero-diff arm  -> VALID scored cell (LOC 0, judge scores it "none").
 *   - harvest failure -> cell FAILED, harvest: null recorded.
 *   - judge still malformed after armJudge's bounded retries -> judge_error
 *     cell: excluded from aggregates, surfaced in the run report, never
 *     silently dropped.
 *
 * The harness (tasks, fixtures, skill assembly, arm setup, diff capture)
 * lives in test/helpers/arm-benchmark-harness.ts, shared with the FREE
 * selftest at test/arm-benchmark-selftest.test.ts — which runs in
 * `bun run test` on every PR so this paid instrument can never burn money on
 * broken fixtures or plumbing. Everything needing a live model is here,
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
import { armJudge, type ArmJudgeScore } from './helpers/llm-judge';
import {
  ARM_MAX_TURNS, ARM_TIMEOUT_MS, ARM_JUDGE_DIFF_CAP, ARM_ALLOWED_TOOLS,
  TASK_TEST_TIMEOUT_MS, SKILL_NAME, TASKS,
  setupArm, captureStagedDiff, runChecks,
  type Arm, type ArmTask, type DiffHarvest,
} from './helpers/arm-benchmark-harness';
import * as fs from 'fs';


// --- Cell runner + reporting ---

interface CellResult {
  task: string;
  arm: Arm;
  exitReason: string;
  harvest: DiffHarvest | null;
  harvestError: string | null;
  judge: ArmJudgeScore | null;
  judgeError: string | null;
  /** Deterministic functional-check outcome ('none' = task has no oracle).
   *  Correctness comes before LOC in the metric order — a refusal, a broken
   *  implementation, and working code must be distinguishable in the cells. */
  checks: 'pass' | 'fail' | 'none';
  consulted: boolean;
  costUsd: number;
  tokens: number;
  turns: number;
}

const evalCollector = createEvalCollector('e2e-arm-benchmark');
const allCells: CellResult[] = [];

function skillConsulted(result: SkillTestResult): boolean {
  return result.toolCalls.some((tc) =>
    (tc.tool === 'Skill' && String((tc.input as { skill?: unknown })?.skill ?? '').includes(SKILL_NAME))
    || JSON.stringify(tc.input ?? {}).includes(`.claude/skills/${SKILL_NAME}`));
}

async function runArmCell(task: ArmTask, arm: Arm): Promise<CellResult> {
  const dirs = setupArm(task, arm);
  try {
    const invocation = arm === 'with-skill'
      ? `First invoke the ${SKILL_NAME} skill (via the Skill tool) and follow it while implementing.\n\n`
      : '';
    const result = await runSkillTest({
      prompt: `${invocation}${task.ticket}`,
      workingDirectory: dirs.dir,
      maxTurns: ARM_MAX_TURNS,
      allowedTools: ARM_ALLOWED_TOOLS,
      timeout: ARM_TIMEOUT_MS,
      testName: `${task.key}-${arm}`,
      runId,
    });
    logCost(`arm-benchmark ${task.fixture} ${arm}`, result);

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

    // Judge taxonomy: still malformed after armJudge's bounded retries ->
    // judge_error cell (excluded from aggregates, surfaced in the report).
    let judge: ArmJudgeScore | null = null;
    let judgeError: string | null = null;
    const judgeDiffTruncated = harvest !== null && harvest.patch.length > ARM_JUDGE_DIFF_CAP;
    if (harvest) {
      if (judgeDiffTruncated) {
        console.warn(`[arm-benchmark ${task.key}-${arm}] judge diff truncated to ${ARM_JUDGE_DIFF_CAP}B of ${harvest.patch.length}B — the judgement may miss constructs past the cap.`);
      }
      try {
        judge = await armJudge(task.ticket, harvest.patch.slice(0, ARM_JUDGE_DIFF_CAP));
      } catch (err) {
        judgeError = err instanceof Error ? err.message : String(err);
      }
    }

    const consulted = skillConsulted(result);
    const passed = result.exitReason === 'success' && harvest !== null;
    recordE2E(evalCollector, `${task.key}-${arm}`, 'Arm Benchmark', result, {
      passed,
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
      error: harvestError ?? undefined,
    });

    const cell: CellResult = {
      task: task.key,
      arm,
      exitReason: result.exitReason,
      harvest,
      harvestError,
      judge,
      judgeError,
      checks,
      consulted,
      costUsd: result.costEstimate.estimatedCost,
      tokens: result.costEstimate.estimatedTokens,
      turns: result.costEstimate.turnsUsed,
    };
    allCells.push(cell);
    return cell;
  } finally {
    fs.rmSync(dirs.dir, { recursive: true, force: true });
    fs.rmSync(dirs.originDir, { recursive: true, force: true });
  }
}

function cellLine(c: CellResult): string {
  const score = c.judge
    ? `${c.judge.over_engineering}/3 (${c.judge.construct})`
    : c.judgeError ? 'judge_error' : 'unscored';
  const loc = c.harvest
    ? `+${c.harvest.insertions}/-${c.harvest.deletions} net ${c.harvest.net} in ${c.harvest.filesChanged} file(s)`
    : `harvest FAILED: ${c.harvestError}`;
  return `  ${c.arm.padEnd(14)} score=${score}  checks=${c.checks}  loc=${loc}  turns=${c.turns}  `
    + `tokens=${(c.tokens / 1000).toFixed(1)}k  cost=$${c.costUsd.toFixed(2)}  consulted=${c.consulted}`;
}

function printTaskReport(task: ArmTask, cells: CellResult[]): void {
  console.log(`\n[arm-benchmark ${task.key}] diff-quality first: score, then LOC.`);
  for (const c of cells) console.log(cellLine(c));
}

/** Aggregate across all scored cells. judge_error cells are excluded from
 *  the means but counted and named — never silently dropped. */
function printAggregate(cells: CellResult[]): void {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log('\n[arm-benchmark aggregate] research instrument — informs strategy, gates nothing.');
  for (const arm of ['with-skill', 'without-skill'] as const) {
    const scored = cells.filter((c) => c.arm === arm && c.judge && c.harvest);
    const judgeErrors = cells.filter((c) => c.arm === arm && c.judgeError);
    console.log(
      `  ${arm.padEnd(14)} n=${scored.length}  `
      + `mean_over_engineering=${mean(scored.map((c) => c.judge!.over_engineering)).toFixed(2)}  `
      + `mean_net_loc=${mean(scored.map((c) => c.harvest!.net)).toFixed(1)}  `
      + `mean_tokens=${(mean(scored.map((c) => c.tokens)) / 1000).toFixed(1)}k  `
      + `judge_errors=${judgeErrors.length}`
      + (judgeErrors.length ? ` (${judgeErrors.map((c) => c.task).join(', ')})` : ''),
    );
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
      const [withCell, withoutCell] = await Promise.all([
        runArmCell(task, 'with-skill'),
        runArmCell(task, 'without-skill'),
      ]);
      printTaskReport(task, [withCell, withoutCell]);

      // Harness mechanics only. Score direction is deliberately unasserted:
      // this is a research instrument, and uncomfortable numbers are the point.
      expect(withCell.exitReason, 'with-skill arm did not finish cleanly').toBe('success');
      expect(withoutCell.exitReason, 'without-skill arm did not finish cleanly').toBe('success');
      expect(withCell.harvest, `with-skill harvest failed: ${withCell.harvestError}`).not.toBeNull();
      expect(withoutCell.harvest, `without-skill harvest failed: ${withoutCell.harvestError}`).not.toBeNull();
      // The A/B is vacuous unless the with-arm actually consulted the skill
      // and the without-arm could not have.
      expect(withCell.consulted, `with-arm transcript never consulted ${SKILL_NAME} — vacuous comparison`).toBe(true);
      expect(withoutCell.consulted, 'without-arm transcript references the skill it should not have').toBe(false);
    }, TASK_TEST_TIMEOUT_MS);
  });
}

afterAll(async () => {
  if (allCells.length > 0) printAggregate(allCells);
  await finalizeEvalCollector(evalCollector);
});

