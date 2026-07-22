import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const GEN = path.join(ROOT, 'scripts', 'gstack2', 'generate-skill-tree.ts');

// The same generated roots the mutating check-generated.ts guards. Used only to
// scope the git-status snapshot that proves the check itself wrote nothing.
const GENERATED_ROOTS = ['skills', 'compat', 'evals/parity', 'docs/gstack-2'];

function generatedStatus(): string {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...GENERATED_ROOTS],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  return result.stdout;
}

function runCheck() {
  return spawnSync('bun', ['run', GEN, '--check'], { cwd: ROOT, encoding: 'utf8' });
}

describe('GStack 2 non-mutating generation check', () => {
  test('verifies the tree without writing any file', () => {
    const before = generatedStatus();
    const result = runCheck();
    // The defining guarantee: running the check leaves the working tree byte-identical.
    expect(generatedStatus()).toBe(before);
    // A clean tree (the state under `bun run gen:gstack2 && test:gstack2`) verifies fresh.
    if (before.trim() === '') {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('verified fresh without writing');
    }
  }, 60_000);

  test('reports drift for a deliberately-stale generated file and still writes nothing', () => {
    const target = path.join(ROOT, 'skills', 'plan', 'SKILL.md');
    const original = fs.readFileSync(target);
    const before = generatedStatus();
    try {
      fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n<!-- drift probe -->\n')]));
      const result = runCheck();
      // Drift must fail the check and name the stale path.
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('skills/plan/SKILL.md');
    } finally {
      fs.writeFileSync(target, original);
    }
    // With the tampered file restored, the check having written nothing means the
    // tree is exactly where it started. Any regeneration side effect would break this.
    expect(generatedStatus()).toBe(before);
  }, 60_000);
});
