#!/usr/bin/env bun
/**
 * Compare two eval runs from the project eval dir (~/.gstack/projects/<slug>/evals;
 * legacy fallback ~/.gstack-dev/evals)
 *
 * Usage:
 *   bun run eval:compare                    # compare two most recent of same tier
 *   bun run eval:compare <file>             # compare file against its predecessor
 *   bun run eval:compare <file-a> <file-b>  # compare two specific files
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  findPreviousRun,
  compareEvalResults,
  formatComparison,
  getProjectEvalDir,
  isPartialEval,
  listEvalJsonFiles,
} from '../test/helpers/eval-store';
import type { EvalResult } from '../test/helpers/eval-store';

const EVAL_DIR = getProjectEvalDir();

function loadResult(filepath: string): EvalResult {
  // Resolve relative to EVAL_DIR if not absolute
  const resolved = path.isAbsolute(filepath) ? filepath : path.join(EVAL_DIR, filepath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
}

const args = process.argv.slice(2);

let beforeFile: string;
let afterFile: string;

if (args.length === 2) {
  // Two explicit files
  beforeFile = args[0];
  afterFile = args[1];
} else if (args.length === 1) {
  // One file — find its predecessor
  afterFile = args[0];
  const resolved = path.isAbsolute(afterFile) ? afterFile : path.join(EVAL_DIR, afterFile);
  const afterResult = loadResult(resolved);
  const prev = findPreviousRun(EVAL_DIR, afterResult.tier, afterResult.branch, resolved);
  if (!prev) {
    console.log('No previous run found to compare against.');
    process.exit(0);
  }
  beforeFile = prev;
} else {
  // No args — find two most recent of the same tier. Scans the flat dir plus
  // one level of shards/<slug>/; in-progress accumulators are never the
  // "after" run (comparing against a half-finished run says nothing).
  const files = listEvalJsonFiles(EVAL_DIR)
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  if (files.length === 0) {
    console.log('No eval runs yet. Run: EVALS=1 bun run test:evals');
    process.exit(0);
  }
  if (files.length < 2) {
    console.log('Need at least 2 eval runs to compare. Run evals again.');
    process.exit(0);
  }

  // Most recent finalized file
  const latest = files.find(f => {
    try {
      return !isPartialEval(JSON.parse(fs.readFileSync(f, 'utf-8')), f);
    } catch {
      return false;
    }
  });
  if (!latest) {
    console.log('No completed eval runs yet. Run: EVALS=1 bun run test:evals');
    process.exit(0);
  }
  afterFile = latest;
  const afterResult = loadResult(afterFile);
  const prev = findPreviousRun(EVAL_DIR, afterResult.tier, afterResult.branch, afterFile);
  if (!prev) {
    console.log('No previous run of the same tier found to compare against.');
    process.exit(0);
  }
  beforeFile = prev;
}

const beforeResult = loadResult(beforeFile);
const afterResult = loadResult(afterFile);

// Warn if different tiers
if (beforeResult.tier !== afterResult.tier) {
  console.warn(`Warning: comparing different tiers (${beforeResult.tier} vs ${afterResult.tier})`);
}

// Warn on schema mismatch
if (beforeResult.schema_version !== afterResult.schema_version) {
  console.warn(`Warning: schema version mismatch (${beforeResult.schema_version} vs ${afterResult.schema_version})`);
}

const comparison = compareEvalResults(beforeResult, afterResult, beforeFile, afterFile);
console.log(formatComparison(comparison));
