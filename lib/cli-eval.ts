#!/usr/bin/env bun
/**
 * Unified eval CLI: gstack eval <subcommand>
 *
 * Subcommands:
 *   list [--branch <name>] [--tier <tier>] [--limit N]
 *   compare [file-a] [file-b]
 *   summary [--limit N]
 *   push <file>
 *   cost <file>
 *   cache read|write|stats|clear|verify [args...]
 *   watch
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  EVAL_DIR,
  GSTACK_DEV_DIR,
  readJSON,
  listEvalFiles,
  loadEvalResults,
  formatTimestamp,
} from './util';
import {
  findPreviousRun,
  compareEvalResults,
  formatComparison,
} from '../test/helpers/eval-store';
import type { EvalResult } from '../test/helpers/eval-store';
import type { ComparisonResult } from '../test/helpers/eval-store';
import { computeLeaderboard, type LeaderboardEntry } from './dashboard-queries';

// --- ANSI color helpers ---

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

function green(s: string): string { return isTTY ? `\x1b[32m${s}\x1b[0m` : s; }
function red(s: string): string { return isTTY ? `\x1b[31m${s}\x1b[0m` : s; }
function dim(s: string): string { return isTTY ? `\x1b[2m${s}\x1b[0m` : s; }

/**
 * Wrap ANSI colors around comparison arrows: ↑ green, ↓ red, = dim.
 */
export function formatComparisonColor(c: ComparisonResult): string {
  const plain = formatComparison(c);
  if (!isTTY) return plain;
  return plain
    .replace(/↑/g, green('↑'))
    .replace(/↓/g, red('↓'))
    .replace(/ = /g, dim(' = '));
}

// --- Subcommands ---

async function cmdList(args: string[]): Promise<void> {
  let filterBranch: string | null = null;
  let filterTier: string | null = null;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--branch' && args[i + 1]) { filterBranch = args[++i]; }
    else if (args[i] === '--tier' && args[i + 1]) { filterTier = args[++i]; }
    else if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[++i], 10); }
  }

  const files = listEvalFiles();
  if (files.length === 0) {
    console.log('No eval runs yet. Run: EVALS=1 bun run test:evals');
    return;
  }

  interface RunSummary {
    file: string;
    timestamp: string;
    branch: string;
    tier: string;
    version: string;
    passed: number;
    total: number;
    cost: number;
  }

  const runs: RunSummary[] = [];
  for (const file of files) {
    const data = readJSON<Record<string, any>>(file);
    if (!data) continue;
    if (filterBranch && data.branch !== filterBranch) continue;
    if (filterTier && data.tier !== filterTier) continue;
    runs.push({
      file: path.basename(file),
      timestamp: data.timestamp || '',
      branch: data.branch || 'unknown',
      tier: data.tier || 'unknown',
      version: data.version || '?',
      passed: data.passed || 0,
      total: data.total_tests || 0,
      cost: data.total_cost_usd || 0,
    });
  }

  runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const displayed = runs.slice(0, limit);

  console.log('');
  console.log(`Eval History (${runs.length} total runs)`);
  console.log('═'.repeat(90));
  console.log(
    '  ' +
    'Date'.padEnd(17) +
    'Branch'.padEnd(28) +
    'Tier'.padEnd(12) +
    'Pass'.padEnd(8) +
    'Cost'.padEnd(8) +
    'Version'
  );
  console.log('─'.repeat(90));

  for (const run of displayed) {
    const date = formatTimestamp(run.timestamp);
    const branch = run.branch.length > 26 ? run.branch.slice(0, 23) + '...' : run.branch.padEnd(28);
    const pass = `${run.passed}/${run.total}`.padEnd(8);
    const cost = `$${run.cost.toFixed(2)}`.padEnd(8);
    console.log(`  ${date.padEnd(17)}${branch}${run.tier.padEnd(12)}${pass}${cost}v${run.version}`);
  }

  console.log('─'.repeat(90));
  const totalCost = runs.reduce((s, r) => s + r.cost, 0);
  console.log(`  ${runs.length} runs | Total spend: $${totalCost.toFixed(2)} | Showing: ${displayed.length}`);
  console.log(`  Dir: ${EVAL_DIR}`);
  console.log('');
}

async function cmdCompare(args: string[]): Promise<void> {
  function loadResult(filepath: string): EvalResult {
    const resolved = path.isAbsolute(filepath) ? filepath : path.join(EVAL_DIR, filepath);
    if (!fs.existsSync(resolved)) {
      console.error(`File not found: ${resolved}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  }

  let beforeFile: string;
  let afterFile: string;

  if (args.length === 2) {
    beforeFile = args[0];
    afterFile = args[1];
  } else if (args.length === 1) {
    afterFile = args[0];
    const resolved = path.isAbsolute(afterFile) ? afterFile : path.join(EVAL_DIR, afterFile);
    const afterResult = loadResult(resolved);
    const prev = findPreviousRun(EVAL_DIR, afterResult.tier, afterResult.branch, resolved);
    if (!prev) {
      console.log('No previous run found to compare against.');
      return;
    }
    beforeFile = prev;
  } else {
    const files = listEvalFiles();
    if (files.length < 2) {
      console.log('Need at least 2 eval runs to compare. Run evals again.');
      return;
    }
    afterFile = files[0];
    const afterResult = loadResult(afterFile);
    const prev = findPreviousRun(EVAL_DIR, afterResult.tier, afterResult.branch, afterFile);
    if (!prev) {
      console.log('No previous run of the same tier found to compare against.');
      return;
    }
    beforeFile = prev;
  }

  const beforeResult = loadResult(beforeFile);
  const afterResult = loadResult(afterFile);

  if (beforeResult.tier !== afterResult.tier) {
    console.warn(`Warning: comparing different tiers (${beforeResult.tier} vs ${afterResult.tier})`);
  }
  if (beforeResult.schema_version !== afterResult.schema_version) {
    console.warn(`Warning: schema version mismatch (${beforeResult.schema_version} vs ${afterResult.schema_version})`);
  }

  const comparison = compareEvalResults(beforeResult, afterResult, beforeFile, afterFile);
  console.log(formatComparisonColor(comparison));
}

async function cmdSummary(args: string[]): Promise<void> {
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[++i], 10); }
  }

  const results = loadEvalResults<EvalResult>(undefined, limit);
  if (results.length === 0) {
    console.log('No eval runs yet. Run: EVALS=1 bun run test:evals');
    return;
  }

  const e2eRuns = results.filter(r => r.tier === 'e2e');
  const judgeRuns = results.filter(r => r.tier === 'llm-judge');
  const totalCost = results.reduce((s, r) => s + (r.total_cost_usd || 0), 0);
  const avgE2ECost = e2eRuns.length > 0 ? e2eRuns.reduce((s, r) => s + r.total_cost_usd, 0) / e2eRuns.length : 0;
  const avgJudgeCost = judgeRuns.length > 0 ? judgeRuns.reduce((s, r) => s + r.total_cost_usd, 0) / judgeRuns.length : 0;

  // Detection rates
  const detectionRates: number[] = [];
  for (const r of e2eRuns) {
    for (const t of r.tests) {
      if (t.detection_rate !== undefined) detectionRates.push(t.detection_rate);
    }
  }
  const avgDetection = detectionRates.length > 0
    ? detectionRates.reduce((a, b) => a + b, 0) / detectionRates.length
    : null;

  // Flaky tests
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
    if (outcomes.length >= 2 && outcomes.some(o => o) && outcomes.some(o => !o)) {
      flakyTests.push(name);
    }
  }

  // Branch stats
  const branchStats = new Map<string, { runs: number; detections: number[] }>();
  for (const r of e2eRuns) {
    if (!branchStats.has(r.branch)) branchStats.set(r.branch, { runs: 0, detections: [] });
    const stats = branchStats.get(r.branch)!;
    stats.runs++;
    for (const t of r.tests) {
      if (t.detection_rate !== undefined) stats.detections.push(t.detection_rate);
    }
  }

  // Print
  console.log('');
  console.log('Eval Summary');
  console.log('═'.repeat(60));
  console.log(`  Total runs:        ${results.length} (${e2eRuns.length} e2e, ${judgeRuns.length} llm-judge)`);
  console.log(`  Total spend:       $${totalCost.toFixed(2)}`);
  console.log(`  Avg cost/e2e:      $${avgE2ECost.toFixed(2)}`);
  console.log(`  Avg cost/judge:    $${avgJudgeCost.toFixed(2)}`);
  if (avgDetection !== null) {
    console.log(`  Avg detection:     ${avgDetection.toFixed(1)} bugs`);
  }
  console.log('─'.repeat(60));

  if (flakyTests.length > 0) {
    console.log(`  Flaky tests (${flakyTests.length}):`);
    for (const name of flakyTests) console.log(`    - ${name}`);
    console.log(`  Run 'bun run eval:trend' for detailed time series.`);
    console.log('─'.repeat(60));
  }

  if (branchStats.size > 0) {
    console.log('  Branches:');
    const sorted = [...branchStats.entries()].sort((a, b) => {
      const avgA = a[1].detections.length > 0 ? a[1].detections.reduce((x, y) => x + y, 0) / a[1].detections.length : 0;
      const avgB = b[1].detections.length > 0 ? b[1].detections.reduce((x, y) => x + y, 0) / b[1].detections.length : 0;
      return avgB - avgA;
    });
    for (const [branch, stats] of sorted) {
      const avgDet = stats.detections.length > 0
        ? stats.detections.reduce((a, b) => a + b, 0) / stats.detections.length
        : null;
      const det = avgDet !== null ? ` avg det: ${avgDet.toFixed(1)}` : '';
      console.log(`    ${branch.padEnd(30)} ${stats.runs} runs${det}`);
    }
    console.log('─'.repeat(60));
  }

  const timestamps = results.map(r => r.timestamp).filter(Boolean).sort();
  if (timestamps.length > 0) {
    console.log(`  Date range: ${formatTimestamp(timestamps[0])} → ${formatTimestamp(timestamps[timestamps.length - 1])}`);
  }
  console.log(`  Dir: ${EVAL_DIR}`);
  console.log('');
}

async function cmdPush(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    console.error('Usage: gstack eval push <file>');
    process.exit(1);
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  // Load and validate
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch (err: any) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  const { validateEvalResult, normalizeToLegacy } = await import('./eval-format');
  const validation = validateEvalResult(data);
  if (!validation.valid) {
    console.error('Validation errors:');
    for (const err of validation.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  // Normalize to legacy format for local tooling (eval:summary, eval:trend, eval:compare)
  const legacyData = normalizeToLegacy(data as any);
  const basename = path.basename(resolved);
  const localPath = path.join(EVAL_DIR, basename);
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify(legacyData, null, 2) + '\n');
  console.log(`Saved to ${localPath} (normalized to legacy format)`);

  // Push to team store (non-fatal)
  try {
    const { pushEvalRun } = await import('./sync');
    const ok = await pushEvalRun(data as Record<string, unknown>);
    if (ok) console.log('Synced to team store ✓');
    else console.log('Sync queued (will retry later)');
  } catch {
    console.log('Team sync not configured — local only');
  }
}

async function cmdCost(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    console.error('Usage: gstack eval cost <file>');
    process.exit(1);
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  const data = readJSON<{ costs?: any[] }>(resolved);
  if (!data) {
    console.error(`Cannot read file: ${resolved}`);
    process.exit(1);
  }

  if (!data.costs || data.costs.length === 0) {
    console.log('No cost data in this eval file.');
    return;
  }

  const { computeCosts, formatCostDashboard } = await import('./eval-cost');
  const dashboard = computeCosts(data.costs);
  console.log(formatCostDashboard(dashboard));
}

async function cmdCache(args: string[]): Promise<void> {
  const sub = args[0];
  const {
    cacheRead, cacheWrite, cacheStats, cacheClear, cacheVerify,
  } = await import('./eval-cache');

  switch (sub) {
    case 'read': {
      const [suite, key] = [args[1], args[2]];
      if (!suite || !key) { console.error('Usage: gstack eval cache read <suite> <key>'); process.exit(1); }
      const data = cacheRead(suite, key);
      if (data === null) { console.log('MISS'); process.exit(1); }
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'write': {
      const [suite, key] = [args[1], args[2]];
      if (!suite || !key) { console.error('Usage: gstack eval cache write <suite> <key> [json]'); process.exit(1); }
      let jsonData: string;
      if (args[3]) {
        jsonData = args[3];
      } else if (!process.stdin.isTTY) {
        jsonData = await Bun.stdin.text();
      } else {
        console.error('Provide JSON as argument or pipe to stdin');
        process.exit(1);
      }
      const parsed = JSON.parse(jsonData);
      cacheWrite(suite, key, parsed);
      console.log('OK');
      break;
    }
    case 'stats': {
      const stats = cacheStats(args[1]);
      if (stats.suites.length === 0) { console.log('Cache is empty'); return; }
      for (const s of stats.suites) {
        const size = s.size_bytes > 1024 ? `${(s.size_bytes / 1024).toFixed(1)}KB` : `${s.size_bytes}B`;
        console.log(`  ${s.name.padEnd(20)} ${s.entries} entries  ${size}`);
      }
      break;
    }
    case 'clear': {
      const result = cacheClear(args[1]);
      console.log(`Cleared ${result.deleted} cache entries`);
      break;
    }
    case 'verify': {
      const result = cacheVerify(args[1]);
      console.log(`Valid: ${result.valid}  Invalid: ${result.invalid}`);
      for (const err of result.errors) console.log(`  ERROR: ${err}`);
      if (result.invalid > 0) process.exit(1);
      break;
    }
    default:
      console.error('Usage: gstack eval cache <read|write|stats|clear|verify> [args...]');
      process.exit(1);
  }
}

async function cmdWatch(): Promise<void> {
  // Delegate to existing watch script
  const watchScript = path.resolve(__dirname, '..', 'scripts', 'eval-watch.ts');
  const proc = Bun.spawn(['bun', 'run', watchScript, ...process.argv.slice(3)], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  process.exit(exitCode);
}

// --- Trend tracking ---

export interface TestTrend {
  name: string;
  tier: string;
  results: Array<{ timestamp: string; passed: boolean }>;
  passRate: number;
  streak: { type: 'pass' | 'fail'; count: number };
  flipCount: number;
  status: 'stable-pass' | 'stable-fail' | 'flaky' | 'improving' | 'degrading';
}

/**
 * Compute per-test pass rate trends from eval results.
 * Pure function — no I/O. Results are ordered chronologically (oldest first).
 */
export function computeTrends(
  results: EvalResult[],
  filterTier?: string,
  filterTest?: string,
): TestTrend[] {
  // Build time series per test (chronological — oldest first)
  const byTest = new Map<string, Array<{ timestamp: string; passed: boolean }>>();

  // Results from loadEvalResults are newest-first, so reverse for chronological
  const chronological = [...results].reverse();

  for (const r of chronological) {
    if (filterTier && r.tier !== filterTier) continue;
    for (const t of r.tests) {
      if (filterTest && t.name !== filterTest) continue;
      const key = `${r.tier}:${t.name}`;
      if (!byTest.has(key)) byTest.set(key, []);
      byTest.get(key)!.push({ timestamp: r.timestamp, passed: t.passed });
    }
  }

  const trends: TestTrend[] = [];

  for (const [key, results] of byTest) {
    const [tier, ...nameParts] = key.split(':');
    const name = nameParts.join(':');
    const total = results.length;
    const passCount = results.filter(r => r.passed).length;
    const passRate = total > 0 ? passCount / total : 0;

    // Streak: walk from newest (end of array) backward
    let streakType: 'pass' | 'fail' = results[results.length - 1].passed ? 'pass' : 'fail';
    let streakCount = 0;
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i].passed ? 'pass' : 'fail';
      if (r === streakType) streakCount++;
      else break;
    }

    // Flip count: transitions between pass and fail
    let flipCount = 0;
    for (let i = 1; i < results.length; i++) {
      if (results[i].passed !== results[i - 1].passed) flipCount++;
    }

    // Classify status
    let status: TestTrend['status'];
    const last3 = results.slice(-3);
    const earlier = results.slice(0, -3);
    const last3AllPass = last3.length >= 3 && last3.every(r => r.passed);
    const last3HasFail = last3.some(r => !r.passed);
    const earlierHadFailures = earlier.some(r => !r.passed);
    const earlierWasPassing = earlier.length > 0 && earlier.every(r => r.passed);

    // Check improving/degrading first — a clear recent trend outranks raw pass rate
    if (last3AllPass && earlierHadFailures) {
      status = 'improving';
    } else if (last3HasFail && earlierWasPassing) {
      status = 'degrading';
    } else if (flipCount >= 3 || (passRate > 0.3 && passRate < 0.7)) {
      status = 'flaky';
    } else if (passRate >= 0.9 && flipCount <= 1) {
      status = 'stable-pass';
    } else if (passRate <= 0.1 && flipCount <= 1) {
      status = 'stable-fail';
    } else if (passRate >= 0.5) {
      status = 'stable-pass';
    } else {
      status = 'stable-fail';
    }

    trends.push({
      name, tier, results, passRate,
      streak: { type: streakType, count: streakCount },
      flipCount, status,
    });
  }

  // Sort: flaky first, then flipCount desc, then name
  trends.sort((a, b) => {
    const statusOrder = { flaky: 0, degrading: 1, improving: 2, 'stable-fail': 3, 'stable-pass': 4 };
    const sa = statusOrder[a.status] ?? 5;
    const sb = statusOrder[b.status] ?? 5;
    if (sa !== sb) return sa - sb;
    if (a.flipCount !== b.flipCount) return b.flipCount - a.flipCount;
    return a.name.localeCompare(b.name);
  });

  return trends;
}

async function cmdTrend(args: string[]): Promise<void> {
  let limit = 10;
  let filterTier: string | undefined;
  let filterTest: string | undefined;
  let useTeam = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[++i], 10); }
    else if (args[i] === '--tier' && args[i + 1]) { filterTier = args[++i]; }
    else if (args[i] === '--test' && args[i + 1]) { filterTest = args[++i]; }
    else if (args[i] === '--team') { useTeam = true; }
  }

  let results: EvalResult[];
  if (useTeam) {
    try {
      const { isSyncConfigured } = await import('./sync-config');
      const { pullEvalRuns } = await import('./sync');
      if (!isSyncConfigured()) {
        console.log('Team sync not configured — showing local data only. See docs/TEAM_SYNC_SETUP.md');
        results = loadEvalResults<EvalResult>(undefined, limit);
      } else {
        const teamRows = await pullEvalRuns({ limit });
        results = teamRows as unknown as EvalResult[];
      }
    } catch {
      console.log('Team sync not available — showing local data only.');
      results = loadEvalResults<EvalResult>(undefined, limit);
    }
  } else {
    results = loadEvalResults<EvalResult>(undefined, limit);
  }

  if (results.length === 0) {
    console.log('No eval runs yet. Run: EVALS=1 bun run test:evals');
    return;
  }

  const trends = computeTrends(results, filterTier, filterTest);

  if (trends.length === 0) {
    console.log('No test data matching filters.');
    return;
  }

  // Determine how many result columns to show
  const maxResults = Math.min(limit, Math.max(...trends.map(t => t.results.length)));

  console.log('');
  console.log(`Test Trends (last ${results.length} runs)`);
  console.log('═'.repeat(80));
  console.log(
    '  ' +
    'Test Name'.padEnd(36) +
    'Rate'.padEnd(7) +
    `Last ${maxResults}`.padEnd(maxResults + 3) +
    'Streak'.padEnd(8) +
    'Status'
  );
  console.log('─'.repeat(80));

  let flakyCount = 0;
  let degradingCount = 0;

  for (const t of trends) {
    if (t.status === 'flaky') flakyCount++;
    if (t.status === 'degrading') degradingCount++;

    const fullName = `${t.tier}:${t.name}`;
    const displayName = fullName.length > 34 ? fullName.slice(0, 31) + '...' : fullName.padEnd(36);
    const rate = `${Math.round(t.passRate * 100)}%`.padEnd(7);

    // Build sparkline of last N results
    const sparkline = t.results
      .slice(-maxResults)
      .map(r => r.passed ? '\u2713' : '\u2717')
      .join('');

    const streak = `${t.streak.count}${t.streak.type === 'pass' ? '\u2713' : '\u2717'}`.padEnd(8);

    // Color status
    let statusStr = t.status;
    if (isTTY) {
      if (t.status === 'flaky' || t.status === 'degrading') statusStr = red(t.status);
      else if (t.status === 'stable-pass' || t.status === 'improving') statusStr = green(t.status);
      else statusStr = dim(t.status);
    }

    console.log(`  ${displayName}${rate}${sparkline.padEnd(maxResults + 3)}${streak}${statusStr}`);
  }

  console.log('─'.repeat(80));
  const parts: string[] = [`${trends.length} tests tracked`];
  if (flakyCount > 0) parts.push(`${flakyCount} flaky`);
  if (degradingCount > 0) parts.push(`${degradingCount} degrading`);
  console.log(`  ${parts.join(' | ')}`);
  console.log('');
}

// --- Leaderboard ---

/** Format leaderboard entries as a terminal table. Pure function for testing. */
export function formatLeaderboard(entries: LeaderboardEntry[]): string {
  if (entries.length === 0) return 'No activity this week.\n';

  const lines: string[] = [];
  lines.push('');
  lines.push('Team Leaderboard (this week)');
  lines.push('═'.repeat(85));
  lines.push(
    '  ' +
    '#'.padEnd(4) +
    'Who'.padEnd(22) +
    'Ships'.padEnd(8) +
    'Evals'.padEnd(8) +
    'Sessions'.padEnd(10) +
    'Pass Rate'.padEnd(12) +
    'Cost'
  );
  lines.push('─'.repeat(85));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rank = `${i + 1}.`.padEnd(4);
    const who = (e.email || e.userId).slice(0, 20).padEnd(22);
    const ships = String(e.ships).padEnd(8);
    const evals = String(e.evalRuns).padEnd(8);
    const sessions = String(e.sessions).padEnd(10);
    const rate = e.avgPassRate !== null ? `${e.avgPassRate.toFixed(0)}%`.padEnd(12) : '—'.padEnd(12);
    const cost = `$${e.totalCost.toFixed(2)}`;
    lines.push(`  ${rank}${who}${ships}${evals}${sessions}${rate}${cost}`);
  }

  lines.push('─'.repeat(85));
  const totalShips = entries.reduce((s, e) => s + e.ships, 0);
  const totalEvals = entries.reduce((s, e) => s + e.evalRuns, 0);
  const totalCost = entries.reduce((s, e) => s + e.totalCost, 0);
  lines.push(`  ${entries.length} contributors | ${totalShips} ships | ${totalEvals} eval runs | $${totalCost.toFixed(2)} spent`);
  lines.push('');
  return lines.join('\n');
}

async function cmdLeaderboard(args: string[]): Promise<void> {
  try {
    const { isSyncConfigured } = await import('./sync-config');
    const { pullTable } = await import('./sync');

    if (!isSyncConfigured()) {
      console.log('Team sync not configured. Run: gstack sync setup');
      console.log('See: docs/TEAM_SYNC_SETUP.md');
      return;
    }

    const [evalRuns, shipLogs, sessions] = await Promise.all([
      pullTable('eval_runs'),
      pullTable('ship_logs'),
      pullTable('session_transcripts'),
    ]);

    const entries = computeLeaderboard({ evalRuns, shipLogs, sessions });
    console.log(formatLeaderboard(entries));
  } catch (err: any) {
    console.error(`Failed to load team data: ${err.message}`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
gstack eval — eval management CLI

Usage: gstack eval <command> [args]

Commands:
  list [--branch X] [--tier X] [--limit N]   List eval runs (default limit: 50)
  compare [file-a] [file-b]                   Compare two eval runs
  summary [--limit N]                         Aggregate stats across all runs
  push <file>                                 Validate + save + sync an eval result
  cost <file>                                 Show per-model cost breakdown
  trend [--limit N] [--tier X] [--test X] [--team]  Per-test pass rate trends
  leaderboard                                 Weekly team leaderboard
  cache read|write|stats|clear|verify         Manage eval cache
  watch                                       Live E2E test dashboard
`);
}

// --- Main (only when run directly, not imported) ---

if (import.meta.main) {
const command = process.argv[2];
const cmdArgs = process.argv.slice(3);

switch (command) {
  case 'list':    cmdList(cmdArgs); break;
  case 'compare': cmdCompare(cmdArgs); break;
  case 'summary': cmdSummary(cmdArgs); break;
  case 'push':    cmdPush(cmdArgs); break;
  case 'cost':    cmdCost(cmdArgs); break;
  case 'trend':       cmdTrend(cmdArgs); break;
  case 'leaderboard': cmdLeaderboard(cmdArgs); break;
  case 'cache':       cmdCache(cmdArgs); break;
  case 'watch':   cmdWatch(); break;
  case '--help': case '-h': case 'help': case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
}
