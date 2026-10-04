#!/usr/bin/env bun
/**
 * Show which E2E and LLM-judge tests would run based on the current git diff.
 *
 * The default profile is `pr` (the PR lane's selection, matching `test:pr`
 * and `eval:bg:pr`); `--profile full` (or EVALS_PROFILE=full) shows the plain
 * touchfile selection over every E2E and LLM-judge entry.
 *
 * Usage:
 *   bun run eval:select                 # PR-lane selection, human-readable
 *   bun run eval:select --json          # machine-readable JSON
 *   bun run eval:select --base main     # override base branch
 *   bun run eval:select --profile full  # full touchfile selection
 */

import * as path from 'path';
import { computePaidCaseSelection } from './test-paid-shards';
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
const profileIdx = args.indexOf('--profile');
const profile = profileIdx >= 0 ? args[profileIdx + 1] : process.env.EVALS_PROFILE ?? 'pr';
if (profile !== 'pr' && profile !== 'full') throw new Error('--profile must be pr or full');

// Detect base branch
const baseBranch = baseOverride || detectBaseBranch(ROOT) || 'main';
const changedFiles = getChangedFiles(baseBranch, ROOT);

if (profile === 'pr') {
  const result = computePaidCaseSelection({ profile, rootDir: ROOT, changedFiles,
    env: { ...process.env, EVALS_BASE: baseBranch } });
  const output = { base: baseBranch, changed_files: changedFiles, profile,
    e2e: { selected: result.selection.e2e }, llm_judge: { selected: result.selection.judges },
    coverage: result.coverage, reason: result.reason };
  if (jsonMode) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`Base: ${baseBranch}\nProfile: pr (${result.coverage?.mode})\nChanged files: ${changedFiles.length}`);
    console.log(`Behavioral probes: ${result.selection.e2e?.join(', ') || 'none'}`);
    console.log(`Quality judges: ${result.selection.judges?.join(', ') || 'none'}`);
    console.log(`Deferred to broad coverage: ${result.coverage?.deferred.map(item => item.id).join(', ') || 'none'}`);
    console.log(result.reason);
  }
  process.exit(0);
}

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
