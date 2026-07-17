#!/usr/bin/env bun

import { ROOT } from './render-legacy';

const GENERATED_PATHS = [
  'skills',
  'compat',
  'evals/parity',
  'docs/gstack-2/JUDGMENT-PARITY.md',
  'docs/gstack-2/JUDGMENT-PROVENANCE.json',
  'docs/gstack-2/SCENARIOS.md',
  'docs/gstack-2/SKILL-MIGRATION.md',
] as const;

const result = Bun.spawnSync({
  cmd: ['git', 'status', '--porcelain=v1', '--untracked-files=all', '--', ...GENERATED_PATHS],
  cwd: ROOT,
  stdout: 'pipe',
  stderr: 'pipe',
});

if (result.exitCode !== 0) {
  throw new Error(`Unable to check generated GStack 2 files: ${result.stderr.toString().trim()}`);
}

const dirty = result.stdout.toString().trim();
if (dirty) {
  process.stderr.write('GStack 2 generated files are stale or uncommitted. Run `bun run gen:gstack2` and commit the resulting files:\n');
  process.stderr.write(`${dirty}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`GStack 2 generated files are fresh (${GENERATED_PATHS.length} path roots checked).\n`);
}
