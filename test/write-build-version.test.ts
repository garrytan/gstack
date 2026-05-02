import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'write-build-version.sh');

function copyScriptToRepo(repo: string) {
  const scriptDir = path.join(repo, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(scriptDir, 'write-build-version.sh'));
}

function readVersions(repo: string) {
  return [
    fs.readFileSync(path.join(repo, 'browse', 'dist', '.version'), 'utf8').trim(),
    fs.readFileSync(path.join(repo, 'design', 'dist', '.version'), 'utf8').trim(),
    fs.readFileSync(path.join(repo, 'make-pdf', 'dist', '.version'), 'utf8').trim(),
  ];
}

describe('write-build-version.sh', () => {
  test('writes unknown in a git repo before the first commit exists', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-unborn-head-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
      copyScriptToRepo(repo);

      const result = spawnSync('bash', ['scripts/write-build-version.sh'], {
        cwd: repo,
        stdio: 'pipe',
      });

      expect(result.status).toBe(0);
      expect(readVersions(repo)).toEqual(['unknown', 'unknown', 'unknown']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('writes unknown when git metadata is not present', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-no-git-'));
    try {
      copyScriptToRepo(repo);

      const result = spawnSync('bash', ['scripts/write-build-version.sh'], {
        cwd: repo,
        stdio: 'pipe',
      });

      expect(result.status).toBe(0);
      expect(readVersions(repo)).toEqual(['unknown', 'unknown', 'unknown']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('writes the current commit sha when HEAD resolves', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-valid-head-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'pipe' });
      fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
      spawnSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'pipe' });
      copyScriptToRepo(repo);

      const expected = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repo,
        stdio: 'pipe',
      }).stdout.toString().trim();
      const result = spawnSync('bash', ['scripts/write-build-version.sh'], {
        cwd: repo,
        stdio: 'pipe',
      });

      expect(result.status).toBe(0);
      expect(readVersions(repo)).toEqual([expected, expected, expected]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
