/**
 * pregate/starter — the policy a repository with none would start from
 * (Lane D, GSTA-112; FOUN #292, harness-evals #81/#82). When no
 * `.gstack/pregate.json` exists on the base branch and no user-owned file is
 * present, or the active policy declares no lanes (no `dependencies` or
 * `empty_lanes`, `selection` or `local` key, GST-775), the lanes check does not fail a touched file with no lane
 * (PREGATE_NO_LANE); it warns (PREGATE_NO_POLICY) and prints this starter:
 * the detected runner, a `dependencies` entry for each unmapped touched file
 * (the tests nearest it, else the tests sharing its stem; never `[]`, which
 * would clear a file without a test), the test directories and the CI lanes
 * seen. Nothing is written here; `gstack-pregate init` is the explicit write.
 */
import * as path from 'node:path';
import { PREGATE_CONFIG_PATH, PREGATE_CONFIG_SCHEMA } from './config';
import { isTestFile, listRepoFiles } from './import-graph';
import { MAX_SUGGESTED, nearestTests } from './init-draft';
import type { PregateContext } from './types';

const MAX_DIRS = 8;


/** `init`'s nearest-directory suggestion, else the tests whose basename starts with the file's stem. */
export function nearestTestsFor(tests: readonly string[], file: string): string[] {
  const nearest = nearestTests(tests, file);
  if (nearest.length) return nearest;
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, '');
  if (!stem) return [];
  const byStem = tests.filter(t => { const b = path.posix.basename(t); return b === stem || b.startsWith(`${stem}.`) || b.startsWith(`${stem}-`) || b.startsWith(`${stem}_`); });
  return byStem.length <= MAX_SUGGESTED ? byStem : [];
}

/** The starter for `noLane` (touched files with no lane) under `runner` (detected by the lanes check; null when none). */
export function starterPolicy(ctx: Pick<PregateContext, 'repoRoot' | 'lanes' | 'config' | 'baseRef' | 'absentUserPolicy' | 'configKind' | 'configLabel' | 'configFile'>, noLane: readonly string[], runner: string | null): string[] {
  const tests = listRepoFiles(ctx.repoRoot).filter(isTestFile).sort();
  const dependencies: Record<string, string[]> = {};
  const todo: string[] = [];
  for (const file of noLane) {
    const suggested = nearestTestsFor(tests, file);
    if (suggested.length) dependencies[file] = suggested; else todo.push(file);
  }
  const json = JSON.stringify({ $schema: PREGATE_CONFIG_SCHEMA, runner, dependencies }, null, 2);
  const dirCounts = new Map<string, number>();
  for (const t of tests) { const d = path.posix.dirname(t); dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1); }
  const dirs = [...dirCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DIRS).map(([d]) => d);
  const lanes = ctx.lanes.filter(l => l.runsTests && !l.manual).map(l => `${l.id} (${l.platform}${l.matrixExpression && l.testFiles.length === 0 && !ctx.config.selection[l.id] ? ', matrix computed; declare selection' : ''})`);
  return [
    ctx.configKind === 'none'
      ? `PREGATE_STARTER: no ${PREGATE_CONFIG_PATH} on ${ctx.baseRef}${ctx.absentUserPolicy ? ` and no user-owned policy at ${ctx.absentUserPolicy}` : ''}; a starter drafted from this repository follows. Review it, write it with gstack-pregate init, edit each TODO, then commit it on the base branch (from then on an unmapped file is PREGATE_NO_LANE)`
      : `PREGATE_STARTER: ${ctx.configLabel} declares no lanes (no dependencies, empty_lanes, selection or local key); a starter drafted from this repository follows. Review it, add its dependencies to ${ctx.configFile}${ctx.configKind === 'user' ? '' : ' on the base branch'} and edit each TODO (from then on an unmapped file is PREGATE_NO_LANE)`,
    `PREGATE_STARTER: runner ${runner ?? 'null (none detected; set runner with {files})'}`,
    `PREGATE_STARTER: test directories: ${dirs.join(', ') || '(no test files found)'}${dirCounts.size > MAX_DIRS ? ` (+${dirCounts.size - MAX_DIRS} more)` : ''}`,
    `PREGATE_STARTER: CI lanes: ${lanes.join(', ') || '(no test job in .github/workflows)'}`,
    `PREGATE_STARTER: begin ${PREGATE_CONFIG_PATH}`,
    ...json.split('\n'),
    'PREGATE_STARTER: end',
    ...todo.map(f => `TODO ${f}: no test lane and no nearby test; add a test, map it under dependencies, or declare [] if no test can cover it`),
  ];
}
