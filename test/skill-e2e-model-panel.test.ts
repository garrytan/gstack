/**
 * Model panel (periodic, paid): particle-1, its open-weight base DeepSeek V4.1
 * Flash, Sonnet 5.5 and Opus 5.5 each run the same five gstack-shaped tasks
 * PANEL_TRIALS times in Claude Code. Each cell is scored by a hidden
 * deterministic check; gateway arms reach their models through OpenRouter
 * with no Anthropic credential in the child env. A research instrument that
 * gates nothing: assertions cover the harness, never which model wins.
 *
 * Spend: every cell reserves its arm's worst case in a shared ledger
 * (<out>/spend.json, cap PANEL_SPEND_CAP_USD) before it starts and settles to
 * the measured cost after, so a staged run (one task first, then the rest)
 * stays under one cap; a refused reservation stops the panel with
 * STOP: reason=budget_exhausted and keeps every row already written, and a
 * cell that died without usage stays charged at its reservation (unknown).
 * Rows append to <out>/rows.jsonl; <out>/summary.json holds the per-arm
 * summary and the preregistered suggestion line. <out> is
 * GSTACK_MODEL_PANEL_OUT, defaulting beside the eval store.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { runSkillTest } from './helpers/session-runner';
import { runId, selectedTests } from './helpers/e2e-helpers';
import { describeE2ETier } from './helpers/e2e-gate';
import { getProjectEvalDir } from './helpers/eval-store';
import { reserve, settle, readLedger, setCap, summarize as spendSummary, renderSpend, SpendCapExceeded } from '../lib/spend-ledger';
import {
  PANEL_ARMS, PANEL_TASKS, PANEL_TRIALS, PANEL_MAX_TURNS, PANEL_TIMEOUT_MS, PANEL_CONCURRENCY, PANEL_ALLOWED_TOOLS, PANEL_SPEND_CAP_USD,
  setupCell, runCheck, armEnv, usageFromTranscript, cellCostUsd, classifyCell, summarize, suggestionLine,
  type PanelArm, type PanelRow, type PanelTask,
} from './helpers/model-panel-harness';
import { SKILL_NAME } from './helpers/arm-benchmark-harness';

const OUT = process.env.GSTACK_MODEL_PANEL_OUT || path.join(path.dirname(getProjectEvalDir()), 'model-panel');
const ROWS = path.join(OUT, 'rows.jsonl');
const SPEND = path.join(OUT, 'spend.json');
let stopped: string | null = null;

function consulted(result: Awaited<ReturnType<typeof runSkillTest>>): boolean {
  return result.toolCalls.some((tc) => tc.tool === 'Skill' && String((tc.input as { skill?: unknown })?.skill ?? '').includes(SKILL_NAME));
}

async function runCell(task: PanelTask, arm: PanelArm, trial: number): Promise<PanelRow | null> {
  if (stopped) return null;
  const attempt = task.id + ':' + arm.id + ':' + trial + ':' + runId;
  try {
    reserve(SPEND, attempt, arm.reserveUsd, { cap: PANEL_SPEND_CAP_USD, label: arm.model });
  } catch (err) {
    if (!(err instanceof SpendCapExceeded)) throw err;
    stopped = err.message;
    process.stderr.write('STOP: reason=budget_exhausted ' + err.message + '\n');
    return null;
  }
  const dirs = setupCell(task, arm.id + '-' + trial);
  const started = Date.now();
  let settled = false;
  try {
    const result = await runSkillTest({
      prompt: task.ticket,
      workingDirectory: dirs.dir,
      maxTurns: PANEL_MAX_TURNS,
      allowedTools: PANEL_ALLOWED_TOOLS,
      timeout: PANEL_TIMEOUT_MS,
      testName: task.id + '-' + arm.id + '-t' + trial,
      runId,
      model: arm.model,
      env: armEnv(arm),
    });
    const usage = usageFromTranscript(result.transcript);
    const costUsd = usage ? cellCostUsd(arm, usage) : null;
    settle(SPEND, attempt, costUsd ?? 'unknown');
    settled = true;
    const cls = classifyCell(arm, result.exitReason, usage);
    const scored = cls.verdict === 'scored' ? runCheck(task, dirs.dir) : null;
    const row: PanelRow = {
      task: task.id, arm: arm.id, model: arm.model, route: arm.route, trial,
      verdict: scored ? (scored.pass ? 'pass' : 'fail') : 'infra',
      reason: scored ? scored.detail : (cls as { reason: string }).reason,
      exitReason: result.exitReason, costUsd, usage, durationMs: Date.now() - started, consulted: consulted(result),
    };
    fs.appendFileSync(ROWS, JSON.stringify({ runId, ...row }) + '\n');
    console.log('[model-panel] ' + task.id + ' ' + arm.id + ' t' + trial + ' ' + row.verdict + ' $' + (costUsd ?? 0).toFixed(4) + ' turns=' + (usage?.turns ?? 0) + ' ' + row.reason);
    return row;
  } finally {
    if (!settled) settle(SPEND, attempt, 'unknown');
    fs.rmSync(dirs.dir, { recursive: true, force: true });
  }
}

async function pool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

const describePaid = describeE2ETier('periodic');

for (const task of PANEL_TASKS) {
  const selected = selectedTests === null || selectedTests.includes(task.id);
  (selected ? describePaid : describe.skip)('Model panel: ' + task.id, () => {
    test(task.id, async () => {
      fs.mkdirSync(OUT, { recursive: true });
      if (readLedger(SPEND).cap_usd === null) setCap(SPEND, PANEL_SPEND_CAP_USD);
      const jobs = PANEL_ARMS.flatMap((arm) => Array.from({ length: PANEL_TRIALS }, (_, i) => () => runCell(task, arm, i + 1)));
      const rows = (await pool(jobs, PANEL_CONCURRENCY)).filter((r): r is PanelRow => r !== null);
      expect(stopped, 'panel stopped: ' + stopped).toBeNull();
      expect(rows).toHaveLength(PANEL_ARMS.length * PANEL_TRIALS);
      for (const row of rows) expect(['pass', 'fail', 'infra']).toContain(row.verdict);
    }, Math.ceil((PANEL_ARMS.length * PANEL_TRIALS) / PANEL_CONCURRENCY) * PANEL_TIMEOUT_MS + 300_000);
  });
}

afterAll(() => {
  if (!fs.existsSync(ROWS)) return;
  const rows = fs.readFileSync(ROWS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as PanelRow);
  const summaries = summarize(rows);
  const suggestion = suggestionLine(summaries, new Date().toISOString().slice(0, 10));
  const spend = spendSummary(readLedger(SPEND));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ rows: rows.length, summaries, suggestion, spend }, null, 2) + '\n');
  console.log('\n[model-panel] research instrument; gates nothing.');
  for (const s of summaries) {
    console.log('  ' + s.label.padEnd(20) + ' ' + s.passes + '/' + s.completed + ' passed (95% ' + (s.low * 100).toFixed(0) + '-' + (s.high * 100).toFixed(0) + '%), infra ' + s.infra + ', $' + s.costPerTaskUsd.toFixed(4) + ' per task');
  }
  console.log('  suggestion: ' + (suggestion.line ?? 'none (' + suggestion.reason + ')'));
  console.log('  ' + renderSpend(spend));
});
