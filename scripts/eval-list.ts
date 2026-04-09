#!/usr/bin/env bun
/**
 * List eval runs from ~/.nstack-dev/evals/
 *
 * Usage: bun run eval:list [--branch <name>] [--tier e2e|llm-judge] [--limit N]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProjectEvalDir } from '../test/helpers/eval-store';

const EVAL_DIR = getProjectEvalDir();

// Parse args
const args = process.argv.slice(2);
let filterBranch: string | null = null;
let filterTier: string | null = null;
let limit = 20;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--branch' && args[i + 1]) { filterBranch = args[++i]; }
  else if (args[i] === '--tier' && args[i + 1]) { filterTier = args[++i]; }
  else if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[++i], 10); }
}

// Read eval files
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

// Parse top-level fields from each file
interface RunSummary {
  file: string;
  timestamp: string;
  branch: string;
  tier: string;
  version: string;
  passed: number;
  total: number;
  cost: number;
  duration: number;
  turns: number;
}

const runs: RunSummary[] = [];
for (const file of files) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, file), 'utf-8'));
    if (filterBranch && data.branch !== filterBranch) continue;
    if (filterTier && data.tier !== filterTier) continue;
    const totalTurns = (data.tests || []).reduce((s: number, t: any) => s + (t.turns_used || 0), 0);
    runs.push({
      file,
      timestamp: data.timestamp || '',
      branch: data.branch || 'unknown',
      tier: data.tier || 'unknown',
      version: data.version || '?',
      passed: data.passed || 0,
      total: data.total_tests || 0,
      cost: data.total_cost_usd || 0,
      duration: data.total_duration_ms || 0,
      turns: totalTurns,
    });
  } catch { continue; }
}

// Sort by timestamp descending
runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

// Apply limit
const displayed = runs.slice(0, limit);

// Print table
console.log('');
console.log(`Eval History (${runs.length} total runs)`);
console.log('═'.repeat(105));
console.log(
  '  ' +
  'Date'.padEnd(17) +
  'Branch'.padEnd(25) +
  'Tier'.padEnd(12) +
  'Pass'.padEnd(8) +
  'Cost'.padEnd(8) +
  'Turns'.padEnd(7) +
  'Duration'.padEnd(10) +
  'Version'
);
console.log('─'.repeat(105));

for (const run of displayed) {
  const date = run.timestamp.replace('T', ' ').slice(0, 16);
  const branch = run.branch.length > 23 ? run.branch.slice(0, 20) + '...' : run.branch.padEnd(25);
  const pass = `${run.passed}/${run.total}`.padEnd(8);
  const cost = `$${run.cost.toFixed(2)}`.padEnd(8);
  const turns = run.turns > 0 ? `${run.turns}t`.padEnd(7) : ''.padEnd(7);
  const dur = run.duration > 0 ? `${Math.round(run.duration / 1000)}s`.padEnd(10) : ''.padEnd(10);
  console.log(`  ${date.padEnd(17)}${branch}${run.tier.padEnd(12)}${pass}${cost}${turns}${dur}v${run.version}`);
}

console.log('─'.repeat(105));

const totalCost = runs.reduce((s, r) => s + r.cost, 0);
const totalDur = runs.reduce((s, r) => s + r.duration, 0);
const totalTurns = runs.reduce((s, r) => s + r.turns, 0);
console.log(`  ${runs.length} runs | $${totalCost.toFixed(2)} total | ${totalTurns} turns | ${Math.round(totalDur / 1000)}s | Showing: ${displayed.length}`);
console.log(`  Dir: ${EVAL_DIR}`);
console.log('');
