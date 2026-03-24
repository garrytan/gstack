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
import { getProjectEvalDir } from '../test/helpers/eval-store';

const EVAL_DIR = getProjectEvalDir();

let files: string[];
try {
  files = fs.readdirSync(EVAL_DIR).filter(f => f.endsWith('.json'));
} catch {
  console.log('No eval runs yet. Run: EVALS=1 bun run test:evals');
  process.exit(0);
}

if (files.length === 0) {
  console.log('No eval runs yet. Run: EVALS=1 bun run test:evals');
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

// Duration + turns from E2E runs
const avgE2EDuration = e2eRuns.length > 0
  ? e2eRuns.reduce((s, r) => s + (r.total_duration_ms || 0), 0) / e2eRuns.length
  : 0;
const e2eTurns: number[] = [];
for (const r of e2eRuns) {
  const runTurns = r.tests.reduce((s, t) => s + (t.turns_used || 0), 0);
  if (runTurns > 0) e2eTurns.push(runTurns);
}
const avgE2ETurns = e2eTurns.length > 0
  ? e2eTurns.reduce((a, b) => a + b, 0) / e2eTurns.length
  : 0;

// Per-test efficiency stats (avg turns + duration across runs)
const testEfficiency = new Map<string, { turns: number[]; durations: number[]; costs: number[] }>();
for (const r of e2eRuns) {
  for (const t of r.tests) {
    if (!testEfficiency.has(t.name)) {
      testEfficiency.set(t.name, { turns: [], durations: [], costs: [] });
    }
    const stats = testEfficiency.get(t.name)!;
    if (t.turns_used !== undefined) stats.turns.push(t.turns_used);
    if (t.duration_ms > 0) stats.durations.push(t.duration_ms);
    if (t.cost_usd > 0) stats.costs.push(t.cost_usd);
  }
}

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
console.log('Eval Summary');
console.log('═'.repeat(70));
console.log(`  Total runs:        ${results.length} (${e2eRuns.length} e2e, ${judgeRuns.length} llm-judge)`);
console.log(`  Total spend:       $${totalCost.toFixed(2)}`);
console.log(`  Avg cost/e2e:      $${avgE2ECost.toFixed(2)}`);
console.log(`  Avg cost/judge:    $${avgJudgeCost.toFixed(2)}`);
if (avgE2EDuration > 0) {
  console.log(`  Avg duration/e2e:  ${Math.round(avgE2EDuration / 1000)}s`);
}
if (avgE2ETurns > 0) {
  console.log(`  Avg turns/e2e:     ${Math.round(avgE2ETurns)}`);
}
if (avgDetection !== null) {
  console.log(`  Avg detection:     ${avgDetection.toFixed(1)} bugs`);
}
console.log('─'.repeat(70));

// Per-test efficiency averages (only if we have enough data)
if (testEfficiency.size > 0 && e2eRuns.length >= 2) {
  console.log('  Per-test efficiency (averages across runs):');
  const sorted = [...testEfficiency.entries()]
    .filter(([, s]) => s.turns.length >= 2)
    .sort((a, b) => {
      const avgA = a[1].costs.reduce((s, c) => s + c, 0) / a[1].costs.length;
      const avgB = b[1].costs.reduce((s, c) => s + c, 0) / b[1].costs.length;
      return avgB - avgA;
    });
  for (const [name, stats] of sorted) {
    const avgT = Math.round(stats.turns.reduce((a, b) => a + b, 0) / stats.turns.length);
    const avgD = Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length / 1000);
    const avgC = (stats.costs.reduce((a, b) => a + b, 0) / stats.costs.length).toFixed(2);
    const label = name.length > 30 ? name.slice(0, 27) + '...' : name.padEnd(30);
    console.log(`    ${label}  $${avgC}  ${avgT}t  ${avgD}s  (${stats.turns.length} runs)`);
  }
  console.log('─'.repeat(70));
}

if (flakyTests.length > 0) {
  console.log(`  Flaky tests (${flakyTests.length}):`);
  for (const name of flakyTests) {
    console.log(`    - ${name}`);
  }
  console.log('─'.repeat(70));
}

if (branchStats.size > 0) {
  console.log('  Branches:');
  const sorted = [...branchStats.entries()].sort((a, b) => b[1].avgDetection - a[1].avgDetection);
  for (const [branch, stats] of sorted) {
    const det = stats.detections.length > 0 ? ` avg det: ${stats.avgDetection.toFixed(1)}` : '';
    console.log(`    ${branch.padEnd(30)} ${stats.runs} runs${det}`);
  }
  console.log('─'.repeat(70));
}

// Date range
const timestamps = results.map(r => r.timestamp).filter(Boolean).sort();
if (timestamps.length > 0) {
  const first = timestamps[0].replace('T', ' ').slice(0, 16);
  const last = timestamps[timestamps.length - 1].replace('T', ' ').slice(0, 16);
  console.log(`  Date range: ${first} → ${last}`);
}

console.log(`  Dir: ${EVAL_DIR}`);
console.log('');
