#!/usr/bin/env bun
/**
 * Aggregate summary of all eval runs from ~/.gstack-dev/evals/
 *
 * Usage: bun run eval:summary
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { EvalResult } from '../test/helpers/eval-store';

const EVAL_DIR = path.join(os.homedir(), '.gstack-dev', 'evals');

let files: string[];
try {
  files = fs.readdirSync(EVAL_DIR).filter(f => f.endsWith('.json'));
} catch {
  console.log('Eval 実行履歴がありません。実行: EVALS=1 bun run test:evals');
  process.exit(0);
}

if (files.length === 0) {
  console.log('Eval 実行履歴がありません。実行: EVALS=1 bun run test:evals');
  process.exit(0);
}

// Load all results
const results: EvalResult[] = [];
for (const file of files) {
  try {
    results.push(JSON.parse(fs.readFileSync(path.join(EVAL_DIR, file), 'utf-8')));
  } catch { continue; }
}

// Aggregate stats
const e2eRuns = results.filter(r => r.tier === 'e2e');
const judgeRuns = results.filter(r => r.tier === 'llm-judge');
const totalCost = results.reduce((s, r) => s + (r.total_cost_usd || 0), 0);
const avgE2ECost = e2eRuns.length > 0 ? e2eRuns.reduce((s, r) => s + r.total_cost_usd, 0) / e2eRuns.length : 0;
const avgJudgeCost = judgeRuns.length > 0 ? judgeRuns.reduce((s, r) => s + r.total_cost_usd, 0) / judgeRuns.length : 0;

// Detection rates from outcome evals
const detectionRates: number[] = [];
for (const r of e2eRuns) {
  for (const t of r.tests) {
    if (t.detection_rate !== undefined) {
      detectionRates.push(t.detection_rate);
    }
  }
}
const avgDetection = detectionRates.length > 0
  ? detectionRates.reduce((a, b) => a + b, 0) / detectionRates.length
  : null;

// Flaky tests (passed in some runs, failed in others)
const testResults = new Map<string, boolean[]>();
for (const r of results) {
  for (const t of r.tests) {
    const key = `${r.tier}:${t.name}`;
    if (!testResults.has(key)) testResults.set(key, []);
    testResults.get(key)!.push(t.passed);
  }
}
const flakyTests: string[] = [];
for (const [name, outcomes] of testResults) {
  if (outcomes.length >= 2) {
    const hasPass = outcomes.some(o => o);
    const hasFail = outcomes.some(o => !o);
    if (hasPass && hasFail) flakyTests.push(name);
  }
}

// Branch stats
const branchStats = new Map<string, { runs: number; avgDetection: number; detections: number[] }>();
for (const r of e2eRuns) {
  if (!branchStats.has(r.branch)) {
    branchStats.set(r.branch, { runs: 0, avgDetection: 0, detections: [] });
  }
  const stats = branchStats.get(r.branch)!;
  stats.runs++;
  for (const t of r.tests) {
    if (t.detection_rate !== undefined) {
      stats.detections.push(t.detection_rate);
    }
  }
}
for (const stats of branchStats.values()) {
  stats.avgDetection = stats.detections.length > 0
    ? stats.detections.reduce((a, b) => a + b, 0) / stats.detections.length
    : 0;
}

// Print summary
console.log('');
console.log('Eval サマリー');
console.log('═'.repeat(60));
console.log(`  総実行数:          ${results.length}（e2e: ${e2eRuns.length}, llm-judge: ${judgeRuns.length}）`);
console.log(`  合計コスト:        $${totalCost.toFixed(2)}`);
console.log(`  平均コスト/e2e:    $${avgE2ECost.toFixed(2)}`);
console.log(`  平均コスト/judge:  $${avgJudgeCost.toFixed(2)}`);
if (avgDetection !== null) {
  console.log(`  平均検出数:        ${avgDetection.toFixed(1)} 件`);
}
console.log('─'.repeat(60));

if (flakyTests.length > 0) {
  console.log(`  Flaky テスト（${flakyTests.length} 件）:`);
  for (const name of flakyTests) {
    console.log(`    - ${name}`);
  }
  console.log('─'.repeat(60));
}

if (branchStats.size > 0) {
  console.log('  ブランチ別:');
  const sorted = [...branchStats.entries()].sort((a, b) => b[1].avgDetection - a[1].avgDetection);
  for (const [branch, stats] of sorted) {
    const det = stats.detections.length > 0 ? ` 平均検出: ${stats.avgDetection.toFixed(1)}` : '';
    console.log(`    ${branch.padEnd(30)} ${stats.runs} 回${det}`);
  }
  console.log('─'.repeat(60));
}

// Date range
const timestamps = results.map(r => r.timestamp).filter(Boolean).sort();
if (timestamps.length > 0) {
  const first = timestamps[0].replace('T', ' ').slice(0, 16);
  const last = timestamps[timestamps.length - 1].replace('T', ' ').slice(0, 16);
  console.log(`  期間: ${first} → ${last}`);
}

console.log(`  ディレクトリ: ${EVAL_DIR}`);
console.log('');
