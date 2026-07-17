import { expect, test } from 'bun:test';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test('skill:check accepts the six-skill package without reviving retired monoliths', () => {
  const result = Bun.spawnSync(['bun', 'run', 'scripts/skill-check.ts'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode).toBe(0);
  expect(output).toContain('exactly six dispatchers (debug, design, plan, qa, review, ship)');
  expect(output).toContain('monolith output retired by GStack 2');
  expect(output).not.toContain('generated file missing');
});
