#!/usr/bin/env bun
/**
 * List eval runs from ~/.gstack-dev/evals/
 *
 * Usage: bun run eval:list [--branch <name>] [--tier e2e|llm-judge] [--limit N]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const EVAL_DIR = path.join(os.homedir(), '.gstack-dev', 'evals');

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
}

const runs: RunSummary[] = [];
for (const file of files) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, file), 'utf-8'));
    if (filterBranch && data.branch !== filterBranch) continue;
    if (filterTier && data.tier !== filterTier) continue;
    runs.push({
      file,
      timestamp: data.timestamp || '',
      branch: data.branch || 'unknown',
      tier: data.tier || 'unknown',
      version: data.version || '?',
      passed: data.passed || 0,
      total: data.total_tests || 0,
      cost: data.total_cost_usd || 0,
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
  const date = run.timestamp.replace('T', ' ').slice(0, 16);
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
