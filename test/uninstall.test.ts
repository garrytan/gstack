import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const UNINSTALL = path.join(ROOT, 'bin', 'gstack-uninstall');

describe('gstack-uninstall', () => {
  test('syntax check passes', () => {
    const result = spawnSync('bash', ['-n', UNINSTALL], { stdio: 'pipe', timeout: 30_000 });
    expect(result.status).toBe(0);
  });

  test('--help prints usage and exits 0', () => {
    const result = spawnSync('bash', [UNINSTALL, '--help'], { stdio: 'pipe', timeout: 30_000 });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('gstack-uninstall');
    expect(output).toContain('--force');
    expect(output).toContain('--keep-state');
  });

  test('unknown flag exits with error', () => {
    const result = spawnSync('bash', [UNINSTALL, '--bogus'], {
      stdio: 'pipe',
      timeout: 30_000,
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
      spawnSync('git', ['init', '-b', 'main'], { cwd: mockGitRoot, stdio: 'pipe', timeout: 30_000 });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('--force removes global Claude skills and state', () => {
      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        timeout: 30_000,
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
        timeout: 30_000,
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
        timeout: 30_000,
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
        timeout: 30_000,
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

    test('--force removes Cursor gstack skills and leaves other Cursor skills', () => {
      // Cursor installs are rendered real dirs, so removal is gated on the
      // generated banner in SKILL.md (S5) — the managed fixtures carry it.
      const banner = '<!-- AUTO-GENERATED from SKILL.md.tmpl - DO NOT EDIT DIRECTLY -->\n# x\n';
      fs.mkdirSync(path.join(mockHome, '.cursor', 'skills', 'gstack'), { recursive: true });
      fs.writeFileSync(path.join(mockHome, '.cursor', 'skills', 'gstack', 'SKILL.md'), banner);
      fs.mkdirSync(path.join(mockHome, '.cursor', 'skills', 'gstack-review'), { recursive: true });
      fs.writeFileSync(path.join(mockHome, '.cursor', 'skills', 'gstack-review', 'SKILL.md'), banner);
      fs.mkdirSync(path.join(mockHome, '.cursor', 'skills', 'frontend-design'), { recursive: true });
      fs.writeFileSync(path.join(mockHome, '.cursor', 'skills', 'frontend-design', 'SKILL.md'), 'keep');

      fs.mkdirSync(path.join(mockGitRoot, '.cursor', 'skills', 'gstack-ship'), { recursive: true });
      fs.writeFileSync(path.join(mockGitRoot, '.cursor', 'skills', 'gstack-ship', 'SKILL.md'), banner);
      fs.mkdirSync(path.join(mockGitRoot, '.cursor', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(mockGitRoot, '.cursor', 'rules', 'keep.md'), 'keep');

      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'gstack'),
          GSTACK_STATE_DIR: path.join(mockHome, '.gstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);

      expect(fs.existsSync(path.join(mockHome, '.cursor', 'skills', 'gstack'))).toBe(false);
      expect(fs.existsSync(path.join(mockHome, '.cursor', 'skills', 'gstack-review'))).toBe(false);
      expect(fs.existsSync(path.join(mockHome, '.cursor', 'skills', 'frontend-design'))).toBe(true);
      expect(fs.existsSync(path.join(mockGitRoot, '.cursor', 'skills', 'gstack-ship'))).toBe(false);
      expect(fs.existsSync(path.join(mockGitRoot, '.cursor', 'rules', 'keep.md'))).toBe(true);
    });

    // Value: protects=uninstall clears gstack's Gemini CLI skills from ~/.gemini/skills, a folder the user's own skills share;
    //   fails_when=the Gemini block is dropped, or loses the provenance gate and sweeps a user's gstack-prefixed skill;
    //   why_new=#1247 adds the Gemini CLI host; seam=none; no_claim=Gemini CLI itself (temp HOME fixture)
    test('--force removes Gemini CLI gstack skills and leaves the user\'s own', () => {
      const banner = '<!-- AUTO-GENERATED from SKILL.md.tmpl - DO NOT EDIT DIRECTLY -->\n# x\n';
      const skills = path.join(mockHome, '.gemini', 'skills');
      const render = path.join(tmpDir, 'render', 'gstack-review');
      fs.mkdirSync(render, { recursive: true });
      fs.writeFileSync(path.join(render, 'SKILL.md'), banner);
      fs.mkdirSync(path.join(skills, 'gstack'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'gstack', 'SKILL.md'), banner);
      fs.symlinkSync(render, path.join(skills, 'gstack-review'));
      for (const [name, body] of [['gstack-my-notes', '# mine\n'], ['frontend-design', 'keep']]) {
        fs.mkdirSync(path.join(skills, name), { recursive: true });
        fs.writeFileSync(path.join(skills, name, 'SKILL.md'), body);
      }
      fs.writeFileSync(path.join(mockHome, '.gemini', 'settings.json'), '{}');

      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'gstack'),
          GSTACK_STATE_DIR: path.join(mockHome, '.gstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(skills, 'gstack'))).toBe(false);
      expect(fs.existsSync(path.join(skills, 'gstack-review'))).toBe(false);
      expect(fs.existsSync(path.join(render, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(skills, 'gstack-my-notes', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(skills, 'frontend-design', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(mockHome, '.gemini', 'settings.json'))).toBe(true);
      expect(result.stderr.toString()).toContain('gstack-my-notes');
    });

    test("a user's own gstack-prefixed Cursor dir (no banner) survives and is listed", () => {
      // S5: the bare gstack* glob must not sweep a dir that merely starts
      // with "gstack" — provenance comes from the generated banner, and a
      // hand-written SKILL.md never carries it.
      const foreign = path.join(mockHome, '.cursor', 'skills', 'gstack-fork-notes');
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'SKILL.md'), '# my own notes\n');

      const foreignLocal = path.join(mockGitRoot, '.cursor', 'skills', 'gstack-my-rules');
      fs.mkdirSync(foreignLocal, { recursive: true });
      fs.writeFileSync(path.join(foreignLocal, 'SKILL.md'), '# hand-written\n');

      const result = spawnSync('bash', [UNINSTALL, '--force'], {
        stdio: 'pipe',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_DIR: path.join(mockHome, '.claude', 'skills', 'gstack'),
          GSTACK_STATE_DIR: path.join(mockHome, '.gstack'),
        },
        cwd: mockGitRoot,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(foreign)).toBe(true);
      expect(fs.existsSync(foreignLocal)).toBe(true);
      const stderr = result.stderr.toString();
      expect(stderr).toContain('left in place');
      expect(stderr).toContain('gstack-fork-notes');
      expect(stderr).toContain('gstack-my-rules');
    });
  });
});

// ----------------------------------------------------------------------
// Hook-cleanup ordering (phantom-hooks fix). Pre-v1.67.2, the settings
// cleanup ran AFTER `rm -rf $CLAUDE_SKILLS/gstack` — and SETTINGS_HOOK
// resolves via $(dirname "$0") INSIDE that root, so a real global uninstall
// (running the installed copy) silently orphaned every hook. Prior tests
// masked this by running the uninstaller from the repo checkout. This test
// runs the INSTALLED copy.
// ----------------------------------------------------------------------

describe('hook cleanup runs before the install root is deleted', () => {
  test('uninstall executed FROM the install root still removes hook entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-order-'));
    try {
      const mockHome = path.join(tmp, 'home');
      const installRoot = path.join(mockHome, '.claude', 'skills', 'gstack');
      const installBin = path.join(installRoot, 'bin');
      fs.mkdirSync(installBin, { recursive: true });
      // The installed copies — the uninstaller under test IS the one inside
      // the root it deletes.
      for (const b of ['gstack-uninstall', 'gstack-settings-hook', 'gstack-session-update', 'gstack-config', 'gstack-state-root.sh']) {
        const src = path.join(ROOT, 'bin', b);
        const dst = path.join(installBin, b);
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
      }
      const settingsFile = path.join(mockHome, '.claude', 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        hooks: {
          PostToolUse: [{
            matcher: '(AskUserQuestion|mcp__.*__AskUserQuestion)',
            _gstack_source: 'auq-error-fallback',
            hooks: [{ type: 'command', command: '/dead/wt/hosts/claude/hooks/auq-error-fallback-hook', timeout: 5 }],
          }],
          Stop: [{
            hooks: [{ type: 'command', command: `${installRoot}/hosts/claude/hooks/timeline-stop-hook`, timeout: 5 }],
          }],
          PreCompact: [{ hooks: [{ type: 'command', command: '/Users/me/my-own-hook' }] }],
        },
      }, null, 2));
      fs.mkdirSync(path.join(mockHome, '.gstack'), { recursive: true });

      const result = spawnSync('bash', [path.join(installBin, 'gstack-uninstall'), '--force', '--keep-state'], {
        stdio: 'pipe',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_SETTINGS_FILE: settingsFile,
          GSTACK_STATE_ROOT: path.join(mockHome, '.gstack'),
        },
        cwd: tmp,
      });
      expect(result.status).toBe(0);

      // Install root gone…
      expect(fs.existsSync(installRoot)).toBe(false);
      // …and the hook entries were still cleaned (cleanup ran BEFORE deletion).
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      expect(s.hooks?.PostToolUse).toBeUndefined();
      expect(s.hooks?.Stop).toBeUndefined();
      // The user's own hook survives the sweep.
      expect(s.hooks?.PreCompact?.[0]?.hooks?.[0]?.command).toBe('/Users/me/my-own-hook');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    // 30s: the copied uninstaller spawns several bun -e children; on a loaded
    // box their cold starts blow bun's default 5s per-test timeout.
  }, 30000);
});

describe('the Memorable bridge hook is removed by name and the kept config is left honest', () => {
  test('a tag-stripped memorable entry is removed, reported, and memorable_recall is set off under --keep-state', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-memo-'));
    try {
      const mockHome = path.join(tmp, 'home');
      const installRoot = path.join(mockHome, '.claude', 'skills', 'gstack');
      const installBin = path.join(installRoot, 'bin');
      fs.mkdirSync(installBin, { recursive: true });
      for (const b of ['gstack-uninstall', 'gstack-settings-hook', 'gstack-session-update', 'gstack-config', 'gstack-state-root.sh']) {
        const dst = path.join(installBin, b);
        fs.copyFileSync(path.join(ROOT, 'bin', b), dst);
        fs.chmodSync(dst, 0o755);
      }
      const settingsFile = path.join(mockHome, '.claude', 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: `${installRoot}/hosts/claude/hooks/memorable-user-prompt-hook`, timeout: 5 }] },
            { hooks: [{ type: 'command', command: '"/Users/me/.memorable/bin/memorable" hook user-prompt' }] },
          ],
        },
      }, null, 2));
      const stateRoot = path.join(mockHome, '.gstack');
      fs.mkdirSync(stateRoot, { recursive: true });
      const env = { ...process.env, HOME: mockHome, GSTACK_SETTINGS_FILE: settingsFile, GSTACK_STATE_ROOT: stateRoot };
      spawnSync('bash', [path.join(installBin, 'gstack-config'), 'set', 'memorable_recall', 'on'], { env, timeout: 20_000 });

      const result = spawnSync('bash', [path.join(installBin, 'gstack-uninstall'), '--force', '--keep-state'], {
        stdio: 'pipe', timeout: 30_000, env, cwd: tmp, encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Memorable UserPromptSubmit hook');
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      // gstack's entry gone, the vendor's own entry untouched
      expect(s.hooks.UserPromptSubmit).toHaveLength(1);
      expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('.memorable/bin/memorable');
      expect(fs.readFileSync(path.join(stateRoot, 'config.yaml'), 'utf-8')).toMatch(/memorable_recall: off/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});

describe('the Memorable arm stays quiet when nothing of its is registered', () => {
  test('no memorable entry -> no "Memorable UserPromptSubmit hook" in the summary, exit 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-memo-none-'));
    try {
      const mockHome = path.join(tmp, 'home');
      const installRoot = path.join(mockHome, '.claude', 'skills', 'gstack');
      const installBin = path.join(installRoot, 'bin');
      fs.mkdirSync(installBin, { recursive: true });
      for (const b of ['gstack-uninstall', 'gstack-settings-hook', 'gstack-session-update', 'gstack-config', 'gstack-state-root.sh']) {
        const dst = path.join(installBin, b);
        fs.copyFileSync(path.join(ROOT, 'bin', b), dst);
        fs.chmodSync(dst, 0o755);
      }
      const settingsFile = path.join(mockHome, '.claude', 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/Users/me/my-own-hook' }] }] } }, null, 2));
      fs.mkdirSync(path.join(mockHome, '.gstack'), { recursive: true });
      const result = spawnSync('bash', [path.join(installBin, 'gstack-uninstall'), '--force', '--keep-state'], {
        stdio: 'pipe', timeout: 30_000, encoding: 'utf-8', cwd: tmp,
        env: { ...process.env, HOME: mockHome, GSTACK_SETTINGS_FILE: settingsFile, GSTACK_STATE_ROOT: path.join(mockHome, '.gstack') },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('Memorable UserPromptSubmit hook');
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe('/Users/me/my-own-hook');
      // the consent flip only runs when the key reads on: no config file is created just to say off
      expect(fs.existsSync(path.join(mockHome, '.gstack', 'config.yaml'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});

describe('hook cleanup under lock contention is loud, never silent (review-army)', () => {
  test('a held foreign lock during uninstall surfaces the give-up warning on stderr', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-lock-'));
    try {
      const mockHome = path.join(tmp, 'home');
      const installRoot = path.join(mockHome, '.claude', 'skills', 'gstack');
      const installBin = path.join(installRoot, 'bin');
      fs.mkdirSync(installBin, { recursive: true });
      for (const b of ['gstack-uninstall', 'gstack-settings-hook', 'gstack-session-update', 'gstack-config', 'gstack-state-root.sh']) {
        const dst = path.join(installBin, b);
        fs.copyFileSync(path.join(ROOT, 'bin', b), dst);
        fs.chmodSync(dst, 0o755);
      }
      const settingsFile = path.join(mockHome, '.claude', 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        hooks: {
          Stop: [{
            _gstack_source: 'gstack-timeline-stop',
            hooks: [{ type: 'command', command: `${installRoot}/hosts/claude/hooks/timeline-stop-hook` }],
          }],
        },
      }, null, 2));
      fs.mkdirSync(path.join(mockHome, '.gstack'), { recursive: true });
      // A fresh foreign lock: pre-fix, every cleanup call silently skipped and
      // uninstall reported clean while orphaning the hooks forever.
      fs.mkdirSync(`${settingsFile}.lock`);
      fs.writeFileSync(path.join(`${settingsFile}.lock`, 'owner'), 'another-live-process');

      const result = spawnSync('bash', [path.join(installBin, 'gstack-uninstall'), '--force', '--keep-state'], {
        stdio: 'pipe',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_SETTINGS_FILE: settingsFile,
          GSTACK_STATE_ROOT: path.join(mockHome, '.gstack'),
          GSTACK_SETTINGS_LOCK_TIMEOUT_MS: '300',
        },
        cwd: tmp,
      });
      const stderr = result.stderr.toString();
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      const cleaned = s.hooks?.Stop === undefined;
      // Either the sweep still happened, or the user SEES why it didn't.
      expect(cleaned || /could not acquire lock/.test(stderr)).toBe(true);
      expect(/could not acquire lock/.test(stderr)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    // 30s: several settings-hook calls each wait out the 300ms lock give-up,
    // and their bun -e cold starts stack up under load — the default 5s
    // per-test budget is too tight on a busy box.
  }, 30000);
});

describe('the consent key never outlives the hook, even when the config lives outside the removed state dir', () => {
  test('full uninstall (no --keep-state) with GSTACK_STATE_ROOT elsewhere: memorable_recall flips off there', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-memo-root-'));
    try {
      const mockHome = path.join(tmp, 'home');
      const otherRoot = path.join(tmp, 'elsewhere');
      const installRoot = path.join(mockHome, '.claude', 'skills', 'gstack');
      const installBin = path.join(installRoot, 'bin');
      fs.mkdirSync(installBin, { recursive: true });
      fs.mkdirSync(otherRoot, { recursive: true });
      for (const b of ['gstack-uninstall', 'gstack-settings-hook', 'gstack-session-update', 'gstack-config', 'gstack-state-root.sh']) {
        const dst = path.join(installBin, b);
        fs.copyFileSync(path.join(ROOT, 'bin', b), dst);
        fs.chmodSync(dst, 0o755);
      }
      const settingsFile = path.join(mockHome, '.claude', 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {} }));
      fs.mkdirSync(path.join(mockHome, '.gstack'), { recursive: true });
      const env = { ...process.env, HOME: mockHome, GSTACK_SETTINGS_FILE: settingsFile, GSTACK_STATE_ROOT: otherRoot };
      expect(spawnSync('bash', [path.join(installBin, 'gstack-config'), 'set', 'memorable_recall', 'on'], { env, timeout: 20_000 }).status).toBe(0);
      const result = spawnSync('bash', [path.join(installBin, 'gstack-uninstall'), '--force'], {
        stdio: 'pipe', timeout: 30_000, encoding: 'utf-8', cwd: tmp, env,
      });
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(mockHome, '.gstack'))).toBe(false); // the default state dir went
      expect(fs.readFileSync(path.join(otherRoot, 'config.yaml'), 'utf-8')).toMatch(/memorable_recall: off/); // the real config did not keep consent
      expect(result.stdout).toContain('memorable_recall consent (set off)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('the consent flip does not depend on the hook manager being present', () => {
  test('gstack-settings-hook missing from the install: memorable_recall still goes off', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-memo-nohook-'));
    try {
      const mockHome = path.join(tmp, 'home');
      const installRoot = path.join(mockHome, '.claude', 'skills', 'gstack');
      const installBin = path.join(installRoot, 'bin');
      fs.mkdirSync(installBin, { recursive: true });
      for (const b of ['gstack-uninstall', 'gstack-config', 'gstack-state-root.sh']) { // no settings hook, no session-update
        const dst = path.join(installBin, b);
        fs.copyFileSync(path.join(ROOT, 'bin', b), dst);
        fs.chmodSync(dst, 0o755);
      }
      const stateRoot = path.join(mockHome, '.gstack');
      fs.mkdirSync(stateRoot, { recursive: true });
      const env = { ...process.env, HOME: mockHome, GSTACK_STATE_ROOT: stateRoot };
      expect(spawnSync('bash', [path.join(installBin, 'gstack-config'), 'set', 'memorable_recall', 'on'], { env, timeout: 20_000 }).status).toBe(0);
      const result = spawnSync('bash', [path.join(installBin, 'gstack-uninstall'), '--force', '--keep-state'], {
        stdio: 'pipe', timeout: 30_000, encoding: 'utf-8', cwd: tmp, env,
      });
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(stateRoot, 'config.yaml'), 'utf-8')).toMatch(/memorable_recall: off/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('state-root safety: only the default root is deleted (docs/state-root.md)', () => {
  let tmp: string, mockHome: string, installBin: string, installRoot: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-root-'));
    mockHome = path.join(tmp, 'home');
    installRoot = path.join(mockHome, '.claude', 'skills', 'gstack');
    installBin = path.join(installRoot, 'bin');
    fs.mkdirSync(installBin, { recursive: true });
    for (const b of ['gstack-uninstall', 'gstack-config', 'gstack-state-root.sh']) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(installBin, b));
      fs.chmodSync(path.join(installBin, b), 0o755);
    }
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  function uninstall(args: string[], env: Record<string, string>, input?: string) {
    return spawnSync('bash', [path.join(installBin, 'gstack-uninstall'), ...args], {
      cwd: tmp, input, encoding: 'utf-8', timeout: 30_000,
      env: { ...process.env, HOME: mockHome, GSTACK_SETTINGS_FILE: path.join(mockHome, 'settings.json'),
        GSTACK_HOME: '', GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '', CLAUDE_PLUGIN_DATA: '', ...env } as Record<string, string>,
    });
  }

  for (const mode of ['--force', 'interactive'] as const) {
    test(`a custom GSTACK_HOME root is left in place with the removal command (${mode}); $HOME/.gstack goes`, () => {
      const custom = path.join(tmp, 'custom-state');
      fs.mkdirSync(path.join(custom, 'projects'), { recursive: true });
      fs.mkdirSync(path.join(mockHome, '.gstack'), { recursive: true });
      const r = mode === '--force' ? uninstall(['--force'], { GSTACK_HOME: custom }) : uninstall([], { GSTACK_HOME: custom }, 'y\n');
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`left in place: ${custom} (selected by GSTACK_HOME=${custom})`);
      expect(r.stderr).toContain(`fix: after checking it, remove it with rm -rf -- '${custom}'`);
      expect(r.stderr).toContain('docs/state-root.md');
      expect(fs.existsSync(path.join(custom, 'projects'))).toBe(true);
      expect(fs.existsSync(path.join(mockHome, '.gstack'))).toBe(false);
      if (mode === 'interactive') expect(r.stdout).toContain(`(kept) ${custom}`);
    });
  }

  for (const [label, target] of [['$HOME', () => mockHome], ['/', () => '/'], ['the gstack checkout', () => installRoot]] as const) {
    test(`$HOME/.gstack symlinked to ${label} is refused with exit 2 and a fix line`, () => {
      fs.symlinkSync(target(), path.join(mockHome, '.gstack'));
      const r = uninstall(['--force'], {});
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`gstack-uninstall: refusing to delete ${path.join(mockHome, '.gstack')}: `);
      expect(r.stderr).toMatch(/^fix: .*docs\/state-root\.md/m);
      expect(fs.existsSync(path.join(installBin, 'gstack-uninstall'))).toBe(true);
      expect(fs.lstatSync(path.join(mockHome, '.gstack')).isSymbolicLink()).toBe(true);
    });
  }

  test('--keep-state deletes nothing and never refuses', () => {
    const custom = path.join(tmp, 'custom-state');
    fs.mkdirSync(custom, { recursive: true });
    fs.symlinkSync(mockHome, path.join(mockHome, '.gstack'));
    const r = uninstall(['--force', '--keep-state'], { GSTACK_HOME: custom });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('left in place:');
    expect(fs.existsSync(custom)).toBe(true);
    expect(fs.lstatSync(path.join(mockHome, '.gstack')).isSymbolicLink()).toBe(true);
  });
});

// Value: protects=a repo's tracked .gstack/ policy files and the uncommitted work in its .gstack-worktrees/ checkouts;
//   fails_when=uninstall removes per-project state without checking --keep-state, git-tracked files, or dirty worktrees;
//   why_new=GSTA-461 item 9 (data loss under --keep-state); seam=none; no_claim=a real gstack install (temp HOME and state root)
describe('per-project state: tracked files and dirty worktrees survive (GSTA-461 item 9)', () => {
  let tmp: string, home: string, repo: string, gitEnv: Record<string, string>;
  const git = (args: string[], cwd = repo) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', timeout: 30_000, env: gitEnv });
    expect(r.status).toBe(0);
    return r.stdout;
  };
  const uninstall = (args: string[]) => spawnSync('bash', [UNINSTALL, ...args], {
    cwd: repo, encoding: 'utf-8', timeout: 30_000,
    env: { ...gitEnv, HOME: home, GSTACK_DIR: path.join(home, '.claude', 'skills', 'gstack'),
      GSTACK_SETTINGS_FILE: path.join(home, 'settings.json'),
      GSTACK_HOME: '', GSTACK_STATE_ROOT: path.join(home, '.gstack'), GSTACK_STATE_DIR: '', CLAUDE_PLUGIN_DATA: '' },
  });
  const worktree = path.join('.gstack-worktrees', 'run-1', 'lane-1');

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-uninstall-proj-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'proj');
    fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
    gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } as Record<string, string>;
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'gstack'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'gstack', 'SKILL.md'), 'test');
    fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.gstack'), { recursive: true });
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.gstack-worktrees/\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'seed']);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function trackPolicyAndAddBrowseState() {
    fs.writeFileSync(path.join(repo, '.gstack', 'ship-policy.json'), '{"merge":"direct"}\n');
    git(['add', '.gstack/ship-policy.json']);
    git(['commit', '-q', '-m', 'policy']);
    fs.writeFileSync(path.join(repo, '.gstack', '.gitignore'), '*\n');
    fs.writeFileSync(path.join(repo, '.gstack', 'browse.json'), '{}\n');
  }
  function addWorktree(dirty: boolean) {
    git(['worktree', 'add', '-q', '--detach', worktree, 'HEAD']);
    if (dirty) fs.writeFileSync(path.join(repo, worktree, 'wip.txt'), 'unsaved work\n');
  }

  test('--keep-state keeps the repo .gstack/ and every .gstack-worktrees/ checkout', () => {
    trackPolicyAndAddBrowseState();
    addWorktree(true);
    const r = uninstall(['--force', '--keep-state']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(`${repo}/.gstack`);
    expect(fs.existsSync(path.join(repo, '.gstack', 'browse.json'))).toBe(true);
    expect(git(['status', '--short'])).toBe('');
    expect(fs.readFileSync(path.join(repo, worktree, 'wip.txt'), 'utf-8')).toBe('unsaved work\n');
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'gstack'))).toBe(false);
  });

  test('a plain uninstall keeps git-tracked .gstack files and removes the ignored browse state', () => {
    trackPolicyAndAddBrowseState();
    fs.writeFileSync(path.join(repo, '.gstack', 'ship-policy.json'), '{"merge":"queue"}\n');
    const r = uninstall(['--force']);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(repo, '.gstack', 'ship-policy.json'), 'utf-8')).toBe('{"merge":"queue"}\n');
    expect(fs.existsSync(path.join(repo, '.gstack', 'browse.json'))).toBe(false);
    expect(git(['status', '--short', '--', '.gstack'])).toBe(' M .gstack/ship-policy.json\n');
    expect(r.stderr).toContain('kept git-tracked files');
  });

  test('a dirty worktree stops a plain uninstall before anything is removed, naming the worktree and the fix', () => {
    trackPolicyAndAddBrowseState();
    addWorktree(true);
    const r = uninstall(['--force']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`refusing to delete ${path.join(repo, worktree)}: it has uncommitted changes`);
    expect(r.stderr).toMatch(/^fix: .*--keep-state.*--force-worktrees/m);
    expect(fs.readFileSync(path.join(repo, worktree, 'wip.txt'), 'utf-8')).toBe('unsaved work\n');
    expect(fs.existsSync(path.join(repo, '.gstack', 'browse.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'gstack'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.gstack'))).toBe(true);
  });

  test('--force-worktrees removes a dirty worktree and prunes its registration', () => {
    addWorktree(true);
    const r = uninstall(['--force', '--force-worktrees']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.gstack-worktrees'))).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'])).not.toContain('lane-1');
  });

  test('a missing worktree outside .gstack-worktrees keeps its registration and its commits', () => {
    addWorktree(false);
    const away = path.join(tmp, 'usb', 'wt');
    git(['worktree', 'add', '-q', '--detach', away, 'HEAD']);
    git(['commit', '-q', '--allow-empty', '-m', 'unique detached work'], away);
    const head = git(['rev-parse', 'HEAD'], away).trim();
    fs.renameSync(path.join(tmp, 'usb'), path.join(tmp, 'usb.unmounted'));
    const r = uninstall(['--force']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.gstack-worktrees'))).toBe(false);
    const list = git(['worktree', 'list', '--porcelain']);
    expect(list).toContain(`worktree ${away}\nHEAD ${head}\n`);
    expect(list).not.toContain('lane-1');
  });

  test('status.showUntrackedFiles=no does not hide a new file in a worktree', () => {
    addWorktree(true);
    git(['config', 'status.showUntrackedFiles', 'no']);
    const r = uninstall(['--force']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`refusing to delete ${path.join(repo, worktree)}: it has uncommitted changes`);
    expect(fs.existsSync(path.join(repo, worktree, 'wip.txt'))).toBe(true);
  });

  test('a dirty worktree still stops the uninstall after the repo is moved', () => {
    addWorktree(true);
    const moved = path.join(tmp, 'moved');
    fs.renameSync(repo, moved);
    repo = moved;
    const r = uninstall(['--force']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`refusing to delete ${path.join(moved, worktree)}: it is not a registered worktree of this repository`);
    expect(fs.readFileSync(path.join(moved, worktree, 'wip.txt'), 'utf-8')).toBe('unsaved work\n');
  });

  test('a checkout name with a newline never turns into a relative delete', () => {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'app.txt'), 'app\n');
    git(['add', 'src/app.txt']);
    git(['commit', '-q', '-m', 'src']);
    fs.mkdirSync(path.join(repo, '.gstack-worktrees', 'x\nsrc', '.git'), { recursive: true });
    const r = uninstall(['--force']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('refusing to delete');
    expect(fs.readFileSync(path.join(repo, 'src', 'app.txt'), 'utf-8')).toBe('app\n');
  });

  const linkGone = () => {
    try { fs.lstatSync(path.join(repo, '.gstack-worktrees')); return false; } catch { return true; }
  };

  test('a symlinked .gstack-worktrees is unlinked, never followed, even when a checkout behind it has unique commits', () => {
    const store = path.join(repo, 'worktree-store');
    fs.mkdirSync(store);
    fs.symlinkSync(store, path.join(repo, '.gstack-worktrees'));
    addWorktree(false);
    git(['commit', '-q', '--allow-empty', '-m', 'wip'], path.join(repo, worktree));
    const r = uninstall(['--force']);
    expect(r.status).toBe(0);
    expect(linkGone()).toBe(true);
    expect(fs.existsSync(path.join(store, 'run-1', 'lane-1', 'README.md'))).toBe(true);
    expect(git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${path.join(store, 'run-1', 'lane-1')}\n`);
  });

  test('a .gstack-worktrees symlink to a folder inside the repo keeps the worktrees behind it and their ignored files', () => {
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.claude/worktrees/\n.env\n');
    const feat = path.join(repo, '.claude', 'worktrees', 'feat');
    git(['worktree', 'add', '-q', '-b', 'feat', feat]);
    fs.writeFileSync(path.join(feat, '.env'), 'SECRET=1\n');
    fs.symlinkSync('.claude/worktrees', path.join(repo, '.gstack-worktrees'));
    const r = uninstall(['--force']);
    expect(r.status).toBe(0);
    expect(linkGone()).toBe(true);
    expect(fs.readFileSync(path.join(feat, '.env'), 'utf-8')).toBe('SECRET=1\n');
    expect(git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${feat}\n`);
  });

  for (const flags of [['--force'], ['--force', '--force-worktrees']]) {
    test(`a .gstack-worktrees symlink to a folder outside the repo is only unlinked by ${flags.join(' ')}`, () => {
      const store = path.join(tmp, 'worktree-store');
      fs.mkdirSync(store);
      git(['worktree', 'add', '-q', '-b', 'feature', path.join(store, 'feature')]);
      fs.symlinkSync(store, path.join(repo, '.gstack-worktrees'));
      const r = uninstall(flags);
      expect(r.status).toBe(0);
      expect(linkGone()).toBe(true);
      expect(fs.existsSync(path.join(store, 'feature', 'README.md'))).toBe(true);
      expect(git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${path.join(store, 'feature')}\n`);
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'gstack'))).toBe(false);
    });
  }

  test('a .gstack-worktrees symlink to a folder holding the main checkout never deletes the repo', () => {
    fs.symlinkSync(tmp, path.join(repo, '.gstack-worktrees'));
    const r = uninstall(['--force']);
    expect(r.status).toBe(0);
    expect(linkGone()).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'HEAD'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf-8')).toBe('x\n');
  });

  test('a repo under .gstack-worktrees never runs its own config commands during the check', () => {
    const nested = path.join(repo, '.gstack-worktrees', 'run-1', 'clone');
    fs.mkdirSync(nested, { recursive: true });
    git(['init', '-q', '-b', 'main'], nested);
    fs.writeFileSync(path.join(nested, 'a.txt'), 'a\n');
    git(['add', 'a.txt'], nested);
    git(['commit', '-q', '-m', 'a'], nested);
    const marker = path.join(tmp, 'fsmonitor-ran');
    git(['config', 'core.fsmonitor', `touch '${marker}'; false`], nested);
    const r = uninstall(['--force']);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`refusing to delete ${nested}: it is not a registered worktree of this repository`);
  });

  test('a .gstack-worktrees that is itself a git repo stops the uninstall and keeps its work', () => {
    git(['init', '-q', '.gstack-worktrees']);
    fs.writeFileSync(path.join(repo, '.gstack-worktrees', 'wip.txt'), 'unsaved work\n');
    const r = uninstall(['--force']);
    expect(r.status).toBe(2);
    expect(fs.readFileSync(path.join(repo, '.gstack-worktrees', 'wip.txt'), 'utf-8')).toBe('unsaved work\n');
  });

  test('a clean worktree holding a commit no branch contains stops the uninstall', () => {
    addWorktree(false);
    git(['commit', '-q', '--allow-empty', '-m', 'wip'], path.join(repo, worktree));
    const r = uninstall(['--force']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`refusing to delete ${path.join(repo, worktree)}: it has commits no branch or tag contains`);
    expect(fs.existsSync(path.join(repo, worktree))).toBe(true);
  });

  test('hold: a plain uninstall still removes untracked .gstack state and clean worktrees entirely', () => {
    fs.writeFileSync(path.join(repo, '.gstack', 'browse.json'), '{}\n');
    fs.mkdirSync(path.join(repo, '.gstack', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.gstack', 'reports', 'qa.md'), '# qa\n');
    addWorktree(false);
    const r = uninstall(['--force']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${repo}/.gstack/`);
    expect(r.stdout).toContain(`${repo}/.gstack-worktrees/`);
    expect(fs.existsSync(path.join(repo, '.gstack'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.gstack-worktrees'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.gstack'))).toBe(false);
  });
});
