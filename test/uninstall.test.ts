import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const UNINSTALL = path.join(ROOT, 'bin', 'gstack-uninstall');

describe('gstack-uninstall', () => {
  test('syntax check passes', () => {
    const result = spawnSync('bash', ['-n', UNINSTALL], { stdio: 'pipe' });
    expect(result.status).toBe(0);
  });

  test('--help prints usage and exits 0', () => {
    const result = spawnSync('bash', [UNINSTALL, '--help'], { stdio: 'pipe' });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('gstack-uninstall');
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
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-test-'));
      mockHome = path.join(tmpDir, 'home');
      mockGitRoot = path.join(tmpDir, 'repo');

      // Create mock gstack install layout
      fs.mkdirSync(path.join(mockHome, '.claude', 'skills', 'gstack'), { recursive: true });
      fs.writeFileSync(path.join(mockHome, '.claude', 'skills', 'gstack', 'SKILL.md'), 'test');

      // Create per-skill symlinks (both old unprefixed and new prefixed)
      fs.symlinkSync('gstack/review', path.join(mockHome, '.claude', 'skills', 'review'));
      fs.symlinkSync('gstack/ship', path.join(mockHome, '.claude', 'skills', 'gstack-ship'));

      // Create a non-gstack symlink (should NOT be removed)
      fs.mkdirSync(path.join(mockHome, '.claude', 'skills', 'other-tool'), { recursive: true });

      // Create state directory
      fs.mkdirSync(path.join(mockHome, '.gstack', 'projects'), { recursive: true });
      fs.writeFileSync(path.join(mockHome, '.gstack', 'config.json'), '{}');

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
          GSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'gstack'),
          GSTACK_STATE_DIR: path.join(mockHome, '.gstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain('gstack uninstalled');

      // Global skill dir should be removed
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'gstack'))).toBe(false);

      // Per-skill symlinks pointing into gstack/ should be removed
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'review'))).toBe(false);
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'gstack-ship'))).toBe(false);

      // Non-gstack tool should still exist
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'other-tool'))).toBe(true);

      // State should be removed
      expect(fs.existsSync(path.join(mockHome, '.gstack'))).toBe(false);
    });

    test('--keep-state preserves state directory', () => {
      const result = spawnSync('bash', [UNINSTALL, '--force', '--keep-state'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'gstack'),
          GSTACK_STATE_DIR: path.join(mockHome, '.gstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);

      // Skills should be removed
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'gstack'))).toBe(false);

      // State should still exist
      expect(fs.existsSync(path.join(mockHome, '.gstack'))).toBe(true);
      expect(fs.existsSync(path.join(mockHome, '.gstack', 'config.json'))).toBe(true);
    });

    test('clean system outputs nothing to remove', () => {
      const cleanHome = path.join(tmpDir, 'clean-home');
      fs.mkdirSync(cleanHome, { recursive: true });

      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: cleanHome,
          GSTACK_DIR: path.join(cleanHome, 'nonexistent'),
          GSTACK_STATE_DIR: path.join(cleanHome, '.gstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toContain('Nothing to remove');
    });

    test('upgrade path: prefixed install + uninstall cleans both old and new symlinks', () => {
      // Simulate the state after setup --no-prefix followed by setup (with prefix):
      // Both old unprefixed and new prefixed symlinks exist
      // (mockHome already has both 'review' and 'gstack-ship' symlinks)

      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'gstack'),
          GSTACK_STATE_DIR: path.join(mockHome, '.gstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);

      // Both old (review) and new (gstack-ship) symlinks should be gone
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'review'))).toBe(false);
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'gstack-ship'))).toBe(false);

      // Non-gstack should survive
      expect(fs.existsSync(path.join(mockHome, '.claude', 'skills', 'other-tool'))).toBe(true);
    });

    test('portable install removes its marker, managed aliases, hook sidecar, and renamed runtime', () => {
      const skills = path.join(mockHome, '.claude', 'skills');
      const portable = path.join(skills, 'renamed gstack');
      const hookLog = path.join(mockHome, 'hook-cleanup.log');
      fs.rmSync(path.join(skills, 'gstack'), { recursive: true, force: true });
      fs.mkdirSync(path.join(portable, 'bin'), { recursive: true });
      fs.writeFileSync(
        path.join(portable, 'bin', 'gstack-settings-hook'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${hookLog}'\necho 'removed 1'\n`,
        { mode: 0o755 },
      );
      fs.copyFileSync(UNINSTALL, path.join(portable, 'bin', 'gstack-uninstall'));
      fs.writeFileSync(path.join(portable, 'bin', 'gstack-session-update'), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(path.join(skills, '.gstack-root'), `${portable}\n`);

      const managedAlias = path.join(skills, 'gstack-review');
      fs.mkdirSync(managedAlias, { recursive: true });
      fs.writeFileSync(path.join(managedAlias, '.gstack-managed-root'), `${portable}\n`);
      fs.writeFileSync(path.join(managedAlias, 'SKILL.md'), 'managed\n');
      const connectChromeAlias = path.join(skills, 'gstack-connect-chrome');
      fs.mkdirSync(connectChromeAlias, { recursive: true });
      fs.writeFileSync(path.join(connectChromeAlias, '.gstack-managed-root'), `${portable}\n`);
      fs.writeFileSync(path.join(connectChromeAlias, 'SKILL.md'), 'managed\n');

      const sidecar = path.join(skills, 'gstack');
      fs.mkdirSync(sidecar, { recursive: true });
      fs.writeFileSync(path.join(sidecar, '.gstack-hook-runtime'), `${portable}\n`);

      const result = spawnSync('bash', [path.join(portable, 'bin', 'gstack-uninstall'), '--force', '--keep-state'], {
        stdio: 'pipe',
        env: { ...process.env, HOME: mockHome, GSTACK_DIR: portable, GSTACK_STATE_DIR: path.join(mockHome, '.gstack') },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(skills, '.gstack-root'))).toBe(false);
      expect(fs.existsSync(managedAlias)).toBe(false);
      expect(fs.existsSync(connectChromeAlias)).toBe(false);
      expect(fs.existsSync(sidecar)).toBe(false);
      expect(fs.existsSync(portable)).toBe(false);
      expect(fs.existsSync(path.join(skills, 'other-tool'))).toBe(true);
      expect(fs.readFileSync(hookLog, 'utf8')).toContain('remove ');
      expect(fs.readFileSync(hookLog, 'utf8')).toContain('remove-source --source plan-tune-cathedral');
    });

    test('portable uninstall removes only managed alias files and preserves unrelated contents', () => {
      const skills = path.join(mockHome, '.claude', 'skills');
      const portable = path.join(skills, 'renamed gstack');
      const alias = path.join(skills, 'gstack-review');
      fs.rmSync(path.join(skills, 'gstack'), { recursive: true, force: true });
      fs.mkdirSync(path.join(portable, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(skills, '.gstack-root'), `${portable}\n`);
      fs.mkdirSync(path.join(alias, 'sections'), { recursive: true });
      fs.writeFileSync(path.join(alias, '.gstack-managed-root'), `${portable}\n`);
      fs.writeFileSync(path.join(alias, 'SKILL.md'), 'managed\n');
      fs.writeFileSync(path.join(alias, 'sections', 'managed.md'), 'managed\n');
      fs.writeFileSync(path.join(alias, 'USER_FILE'), 'preserve\n');

      const result = spawnSync('bash', [UNINSTALL, '--force', '--keep-state'], {
        stdio: 'pipe',
        env: { ...process.env, HOME: mockHome, GSTACK_DIR: portable, GSTACK_STATE_DIR: path.join(mockHome, '.gstack') },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(alias, 'USER_FILE'))).toBe(true);
      expect(fs.existsSync(path.join(alias, 'SKILL.md'))).toBe(false);
      expect(fs.existsSync(path.join(alias, 'sections'))).toBe(false);
      expect(fs.existsSync(path.join(alias, '.gstack-managed-root'))).toBe(false);
    });

    test('portable uninstall preserves a foreign canonical install that replaced its sidecar', () => {
      const skills = path.join(mockHome, '.claude', 'skills');
      const portable = path.join(skills, 'renamed gstack');
      const canonical = path.join(skills, 'gstack');
      fs.rmSync(canonical, { recursive: true, force: true });
      fs.mkdirSync(path.join(portable, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(skills, '.gstack-root'), `${portable}\n`);
      fs.mkdirSync(canonical, { recursive: true });
      fs.writeFileSync(path.join(canonical, 'FOREIGN_INSTALL'), 'preserve\n');

      const result = spawnSync('bash', [UNINSTALL, '--force', '--keep-state'], {
        stdio: 'pipe',
        env: { ...process.env, HOME: mockHome, GSTACK_DIR: portable, GSTACK_STATE_DIR: path.join(mockHome, '.gstack') },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toContain('not owned by');
      expect(fs.existsSync(path.join(canonical, 'FOREIGN_INSTALL'))).toBe(true);
      expect(fs.existsSync(portable)).toBe(false);
      expect(fs.existsSync(path.join(skills, '.gstack-root'))).toBe(false);
    });

    test('Windows runtime copy proves source ownership and cleans hooks before deletion', () => {
      const skills = path.join(mockHome, '.claude', 'skills');
      const canonical = path.join(skills, 'gstack');
      const source = path.join(tmpDir, 'source checkout');
      const alias = path.join(skills, 'gstack-review');
      const connectChromeAlias = path.join(skills, 'gstack-connect-chrome');
      const hookLog = path.join(mockHome, 'windows-hook-cleanup.log');
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(path.join(canonical, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(skills, '.gstack-root'), `${source}\n`);
      fs.writeFileSync(path.join(canonical, '.gstack-hook-runtime'), `${source}\n`);
      fs.copyFileSync(UNINSTALL, path.join(canonical, 'bin', 'gstack-uninstall'));
      fs.writeFileSync(
        path.join(canonical, 'bin', 'gstack-settings-hook'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${hookLog}'\necho 'removed 1'\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(canonical, 'bin', 'gstack-session-update'), '#!/bin/sh\n', { mode: 0o755 });
      fs.mkdirSync(alias, { recursive: true });
      fs.writeFileSync(path.join(alias, '.gstack-managed-root'), `${source}\n`);
      fs.writeFileSync(path.join(alias, 'SKILL.md'), 'managed\n');
      fs.mkdirSync(connectChromeAlias, { recursive: true });
      fs.writeFileSync(path.join(connectChromeAlias, '.gstack-managed-root'), `${source}\n`);
      fs.writeFileSync(path.join(connectChromeAlias, 'SKILL.md'), 'managed\n');

      const result = spawnSync('bash', [path.join(canonical, 'bin', 'gstack-uninstall'), '--force', '--keep-state'], {
        stdio: 'pipe',
        env: { ...process.env, HOME: mockHome, GSTACK_DIR: canonical, GSTACK_STATE_DIR: path.join(mockHome, '.gstack') },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(canonical)).toBe(false);
      expect(fs.existsSync(alias)).toBe(false);
      expect(fs.existsSync(connectChromeAlias)).toBe(false);
      expect(fs.existsSync(path.join(skills, '.gstack-root'))).toBe(false);
      expect(fs.readFileSync(hookLog, 'utf8')).toContain('remove ');
      expect(fs.readFileSync(hookLog, 'utf8')).toContain('remove-source --source plan-tune-cathedral');
    });

    test('interactive preview discloses the renamed runtime before deletion', () => {
      const skills = path.join(mockHome, '.claude', 'skills');
      const portable = path.join(skills, 'renamed gstack');
      fs.mkdirSync(path.join(portable, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(skills, '.gstack-root'), `${portable}\n`);

      const result = spawnSync('bash', [UNINSTALL, '--keep-state'], {
        input: 'n\n',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: mockHome, GSTACK_DIR: portable, GSTACK_STATE_DIR: path.join(mockHome, '.gstack') },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toContain(`${portable} (active renamed runtime)`);
      expect(fs.existsSync(portable)).toBe(true);
    });
  });
});
