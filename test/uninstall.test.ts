import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const UNINSTALL = path.join(ROOT, 'bin', 'nstack-uninstall');

describe('nstack-uninstall', () => {
  test('syntax check passes', () => {
    const result = spawnSync('bash', ['-n', UNINSTALL], { stdio: 'pipe' });
    expect(result.status).toBe(0);
  });

  test('--help prints usage and exits 0', () => {
    const result = spawnSync('bash', [UNINSTALL, '--help'], { stdio: 'pipe' });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('nstack-uninstall');
    expect(output).toContain('--force');
    expect(output).toContain('--keep-state');
  });

  test('unknown flag exits with error', () => {
    const result = spawnSync('bash', [UNINSTALL, '--bogus'], {
      stdio: 'pipe',
      env: { ...process.env, HOME: '/nonexistent' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain('Unknown option');
  });

  describe('integration tests with mock layout', () => {
    let tmpDir: string;
    let mockHome: string;
    let mockGitRoot: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-uninstall-test-'));
      mockHome = path.join(tmpDir, 'home');
      mockGitRoot = path.join(tmpDir, 'repo');

      // Create mock nstack install layout
      fs.mkdirSync(path.join(mockHome, '.claude', 'skills', 'nstack'), { recursive: true });
      fs.writeFileSync(path.join(mockHome, '.claude', 'skills', 'nstack', 'SKILL.md'), 'test');

      // Create per-skill symlinks (both old unprefixed and new prefixed)
      fs.symlinkSync('nstack/review', path.join(mockHome, '.claude', 'skills', 'review'));
      fs.symlinkSync('nstack/ship', path.join(mockHome, '.claude', 'skills', 'nstack-ship'));

      // Create a non-nstack symlink (should NOT be removed)
      fs.mkdirSync(path.join(mockHome, '.claude', 'skills', 'other-tool'), { recursive: true });

      // Create state directory
      fs.mkdirSync(path.join(mockHome, '.nstack', 'projects'), { recursive: true });
      fs.writeFileSync(path.join(mockHome, '.nstack', 'config.json'), '{}');

      // Create mock git repo
      fs.mkdirSync(mockGitRoot, { recursive: true });
      spawnSync('git', ['init', '-b', 'main'], { cwd: mockGitRoot, stdio: 'pipe' });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('--force removes global Claude skills and state', () => {
      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          NSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'nstack'),
          NSTACK_STATE_DIR: path.join(mockHome, '.nstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain('nstack uninstalled');

      // Global skill dir should be removed
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'nstack'))).toBe(false);

      // Per-skill symlinks pointing into nstack/ should be removed
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'review'))).toBe(false);
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'nstack-ship'))).toBe(false);

      // Non-nstack tool should still exist
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'other-tool'))).toBe(true);

      // State should be removed
      expect(fs.existsSync(path.join(mockHome, '.nstack'))).toBe(false);
    });

    test('--keep-state preserves state directory', () => {
      const result = spawnSync('bash', [UNINSTALL, '--force', '--keep-state'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          NSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'nstack'),
          NSTACK_STATE_DIR: path.join(mockHome, '.nstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);

      // Skills should be removed
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'nstack'))).toBe(false);

      // State should still exist
      expect(fs.existsSync(path.join(mockHome, '.nstack'))).toBe(true);
      expect(fs.existsSync(path.join(mockHome, '.nstack', 'config.json'))).toBe(true);
    });

    test('clean system outputs nothing to remove', () => {
      const cleanHome = path.join(tmpDir, 'clean-home');
      fs.mkdirSync(cleanHome, { recursive: true });

      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: cleanHome,
          NSTACK_DIR: path.join(cleanHome, 'nonexistent'),
          NSTACK_STATE_DIR: path.join(cleanHome, '.nstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toContain('Nothing to remove');
    });

    test('upgrade path: prefixed install + uninstall cleans both old and new symlinks', () => {
      // Simulate the state after setup --no-prefix followed by setup (with prefix):
      // Both old unprefixed and new prefixed symlinks exist
      // (mockHome already has both 'review' and 'nstack-ship' symlinks)

      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          NSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'nstack'),
          NSTACK_STATE_DIR: path.join(mockHome, '.nstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);

      // Both old (review) and new (nstack-ship) symlinks should be gone
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'review'))).toBe(false);
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'nstack-ship'))).toBe(false);

      // Non-nstack should survive
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'other-tool'))).toBe(true);
    });
  });
});
