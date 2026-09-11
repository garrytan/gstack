import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOutsideReviewRepo } from './helpers/outside-voice-fixture';

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

for (const host of ['claude', 'codex'] as const) {
  test(`${host} retries use independent committed fixtures with the same one-line defect`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-retry-'));
    try {
      const first = createOutsideReviewRepo(root, host);
      fs.writeFileSync(path.join(first, 'review-scratch.txt'), 'first attempt evidence');
      const second = createOutsideReviewRepo(root, host);
      expect(second).not.toBe(first);
      expect(fs.realpathSync(path.join(second, '.git'))).not.toBe(fs.realpathSync(path.join(first, '.git')));
      expect(fs.readFileSync(path.join(first, 'review-scratch.txt'), 'utf8')).toBe('first attempt evidence');
      expect(fs.existsSync(path.join(second, 'review-scratch.txt'))).toBe(false);
      for (const repo of [first, second]) {
        expect(git(repo, 'branch', '--show-current')).toBe('feature/invoice-lookup');
        expect(git(repo, 'diff', '--numstat', 'origin/main...HEAD')).toBe('0\t1\tinvoice.ts');
        expect(git(repo, 'show', 'origin/main:invoice.ts')).toContain('invoice.ownerId !== actor.id');
        expect(git(repo, 'show', 'HEAD:invoice.ts')).not.toContain('invoice.ownerId !== actor.id');
      }
      expect(git(second, 'status', '--porcelain')).toBe('');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
