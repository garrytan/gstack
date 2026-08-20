#!/usr/bin/env bun
/**
 * Show which E2E and LLM-judge tests would run based on the current git diff.
 *
 * Usage:
 *   bun run eval:select              # human-readable output
 *   bun run eval:select --json       # machine-readable JSON
 *   bun run eval:select --base main  # override base branch
 */

import * as path from 'path';
import {
  selectTests,
  detectBaseBranch,
  getChangedFiles,
  E2E_TOUCHFILES,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from '../test/helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const baseIdx = args.indexOf('--base');
const baseOverride = baseIdx >= 0 ? args[baseIdx + 1] : undefined;

// Detect base branch
const baseBranch = baseOverride || detectBaseBranch(ROOT) || 'main';
const changedFiles = getChangedFiles(baseBranch, ROOT);

if (changedFiles.length === 0) {
  if (jsonMode) {
    console.log(JSON.stringify({ base: baseBranch, changed_files: 0, e2e: 'all', llm_judge: 'all', reason: 'no diff — would run all tests' }));
  } else {
    console.log(`Base: ${baseBranch}`);
    console.log('No changed files detected — all tests would run.');
  }
  process.exit(0);
}

// baseRef/cwd scope the map-diff path (used when touchfiles-data.ts changed)
// to the same base this script diffed against — including a --base override.
const selectOpts = { baseRef: baseBranch, cwd: ROOT };
const e2eSelection = selectTests(changedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, selectOpts);
const llmSelection = selectTests(changedFiles, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES, selectOpts);

if (jsonMode) {
  console.log(JSON.stringify({
    base: baseBranch,
    changed_files: changedFiles,
    e2e: {
      selected: e2eSelection.selected,
      skipped: e2eSelection.skipped,
      reason: e2eSelection.reason,
      removed_tests: e2eSelection.removedTests ?? [],
      count: `${e2eSelection.selected.length}/${Object.keys(E2E_TOUCHFILES).length}`,
    },
    llm_judge: {
      selected: llmSelection.selected,
      skipped: llmSelection.skipped,
      reason: llmSelection.reason,
      count: `${llmSelection.selected.length}/${Object.keys(LLM_JUDGE_TOUCHFILES).length}`,
    },
  }, null, 2));
} else {
  console.log(`Base: ${baseBranch}`);
  console.log(`Changed files: ${changedFiles.length}`);
  console.log();

  console.log(`E2E: selected ${e2eSelection.selected.length} of ${Object.keys(E2E_TOUCHFILES).length}, reason: ${e2eSelection.reason}`);
  if (e2eSelection.removedTests && e2eSelection.removedTests.length > 0) {
    console.log(`  Removed from maps (reported, not selected): ${e2eSelection.removedTests.join(', ')}`);
  }
  if (e2eSelection.selected.length > 0 && e2eSelection.selected.length < Object.keys(E2E_TOUCHFILES).length) {
    console.log(`  Selected: ${e2eSelection.selected.join(', ')}`);
    console.log(`  Skipped:  ${e2eSelection.skipped.join(', ')}`);
  } else if (e2eSelection.selected.length === 0) {
    console.log('  No E2E tests affected.');
  } else {
    console.log('  All E2E tests selected.');
  }
  console.log();

  console.log(`LLM-judge: selected ${llmSelection.selected.length} of ${Object.keys(LLM_JUDGE_TOUCHFILES).length}, reason: ${llmSelection.reason}`);
  if (llmSelection.selected.length > 0 && llmSelection.selected.length < Object.keys(LLM_JUDGE_TOUCHFILES).length) {
    console.log(`  Selected: ${llmSelection.selected.join(', ')}`);
    console.log(`  Skipped:  ${llmSelection.skipped.join(', ')}`);
  } else if (llmSelection.selected.length === 0) {
    console.log('  No LLM-judge tests affected.');
  } else {
    console.log('  All LLM-judge tests selected.');
  }
}
