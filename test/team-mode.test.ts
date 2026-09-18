import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { runBashScript } from './helpers/bash-script';

const ROOT = path.resolve(import.meta.dir, '..');
const SETTINGS_HOOK = path.join(ROOT, 'bin', 'gstack-settings-hook');
const SESSION_UPDATE = path.join(ROOT, 'bin', 'gstack-session-update');
const TEAM_INIT = path.join(ROOT, 'bin', 'gstack-team-init');

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-test-'));
}

function run(cmd: string, opts: { cwd?: string; env?: Record<string, string> } = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

describe('gstack-settings-hook', () => {
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    settingsFile = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('add creates settings.json if missing', () => {
    const result = run(`${SETTINGS_HOOK} add /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('/path/to/gstack-session-update');
  });

  test('add preserves existing settings', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ effortLevel: 'high', permissions: { defaultMode: 'auto' } }, null, 2));
    const result = run(`${SETTINGS_HOOK} add /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.effortLevel).toBe('high');
    expect(settings.permissions.defaultMode).toBe('auto');
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test('add deduplicates (running twice does not double-add)', () => {
    run(`${SETTINGS_HOOK} add /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    run(`${SETTINGS_HOOK} add /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test('remove removes the hook', () => {
    run(`${SETTINGS_HOOK} add /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    const result = run(`${SETTINGS_HOOK} remove /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks).toBeUndefined();
  });

  test('remove exits 1 when settings.json does not exist', () => {
    const result = run(`${SETTINGS_HOOK} remove /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(1);
  });

  test('remove preserves other hooks', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/path/to/gstack-session-update' }] },
          { hooks: [{ type: 'command', command: '/other/hook' }] },
        ],
      },
    }, null, 2));
    run(`${SETTINGS_HOOK} remove /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('/other/hook');
  });

  test('atomic write (no partial file on success)', () => {
    run(`${SETTINGS_HOOK} add /path/to/gstack-session-update`, {
      env: { GSTACK_SETTINGS_FILE: settingsFile },
    });
    // .tmp file should not exist after successful write
    expect(fs.existsSync(settingsFile + '.tmp')).toBe(false);
    // File should be valid JSON
    expect(() => JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).not.toThrow();
  });
});

describe('gstack-session-update', () => {
  let tmpDir: string;
  let gstackDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    gstackDir = path.join(tmpDir, 'gstack');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(gstackDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Init a git repo to pass the .git guard
    execSync('git init', { cwd: gstackDir, timeout: 30_000 });
    execSync('git commit --allow-empty -m "init"', { cwd: gstackDir, timeout: 30_000 });
    fs.writeFileSync(path.join(gstackDir, 'VERSION'), '0.1.0');

    // Create a minimal gstack-config that returns auto_upgrade=true
    const binDir = path.join(gstackDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'gstack-config'), '#!/bin/bash\necho "true"');
    fs.chmodSync(path.join(binDir, 'gstack-config'), 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('exits 0 when .git is missing', () => {
    fs.rmSync(path.join(gstackDir, '.git'), { recursive: true });
    const result = run(SESSION_UPDATE, {
      env: { GSTACK_DIR: gstackDir, GSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
  });

  test('exits 0 when auto_upgrade is not true', () => {
    // Override gstack-config to return false
    fs.writeFileSync(path.join(gstackDir, 'bin', 'gstack-config'), '#!/bin/bash\necho "false"');
    const result = run(SESSION_UPDATE, {
      env: { GSTACK_DIR: gstackDir, GSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
  });

  test('throttle: skips when checked recently', () => {
    // Write a recent throttle timestamp
    const throttleFile = path.join(stateDir, '.last-session-update');
    fs.writeFileSync(throttleFile, String(Math.floor(Date.now() / 1000)));

    const result = run(SESSION_UPDATE, {
      env: { GSTACK_DIR: gstackDir, GSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
    // No log file should be created (throttled before forking)
  });

  test('always exits 0 (non-fatal)', () => {
    // Even with a broken setup, should exit 0
    const result = run(SESSION_UPDATE, {
      env: { GSTACK_DIR: '/nonexistent/path', GSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
  });
});

describe('gstack-team-init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    execSync('git init', { cwd: tmpDir, timeout: 30_000 });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, timeout: 30_000 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('errors without a mode argument', () => {
    const result = run(TEAM_INIT, { cwd: tmpDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Usage');
  });

  test('errors outside a git repo', () => {
    const nonGitDir = mkTmpDir();
    const result = run(`${TEAM_INIT} optional`, { cwd: nonGitDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not in a git repository');
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  test('optional: creates CLAUDE.md with recommended section', () => {
    const result = run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('## gstack (recommended)');
    expect(claude).toContain('./setup --team');
  });

  test('required: creates CLAUDE.md with required section', () => {
    const result = run(`${TEAM_INIT} required`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('## gstack (REQUIRED');
    expect(claude).toContain('GSTACK_MISSING');
  });

  test('required: creates enforcement hook', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const hookPath = path.join(tmpDir, '.claude', 'hooks', 'check-gstack.sh');
    expect(fs.existsSync(hookPath)).toBe(true);
    const hook = fs.readFileSync(hookPath, 'utf-8');
    expect(hook).toContain('BLOCKED: gstack is not installed');
    // Should be executable
    const stat = fs.statSync(hookPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  test('required: creates project settings.json with PreToolUse hook', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Skill');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('check-gstack');
  });

  test('idempotent: running twice does not duplicate CLAUDE.md section', () => {
    run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const matches = claude.match(/## gstack/g);
    expect(matches).toHaveLength(1);
  });

  test('removes vendored copy when present', () => {
    // Create a fake vendored gstack with VERSION file
    const vendoredDir = path.join(tmpDir, '.claude', 'skills', 'gstack');
    fs.mkdirSync(vendoredDir, { recursive: true });
    fs.writeFileSync(path.join(vendoredDir, 'VERSION'), '0.14.0.0');
    fs.writeFileSync(path.join(vendoredDir, 'README.md'), 'vendored');
    // Track it in git
    execSync('git add .claude/skills/gstack/', { cwd: tmpDir, timeout: 30_000 });
    execSync('git commit -m "add vendored gstack"', { cwd: tmpDir, timeout: 30_000 });

    const result = run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Found vendored gstack copy');
    expect(result.stdout).toContain('Removed vendored copy');
    // Vendored dir should be gone
    expect(fs.existsSync(vendoredDir)).toBe(false);
    // .gitignore should have the entry
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.claude/skills/gstack/');
  });

  test('skips when no vendored copy present', () => {
    const result = run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found vendored gstack copy');
  });

  test('skips when .claude/skills/gstack is a symlink', () => {
    // Create a symlink (not a real vendored copy)
    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const targetDir = mkTmpDir();
    fs.writeFileSync(path.join(targetDir, 'VERSION'), '0.14.0.0');
    fs.symlinkSync(targetDir, path.join(skillsDir, 'gstack'));

    const result = run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found vendored gstack copy');
    // Symlink should still exist
    expect(fs.lstatSync(path.join(skillsDir, 'gstack')).isSymbolicLink()).toBe(true);
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  test('does not duplicate .gitignore entry on re-run', () => {
    // Create vendored copy
    const vendoredDir = path.join(tmpDir, '.claude', 'skills', 'gstack');
    fs.mkdirSync(vendoredDir, { recursive: true });
    fs.writeFileSync(path.join(vendoredDir, 'VERSION'), '0.14.0.0');
    execSync('git add .claude/skills/gstack/', { cwd: tmpDir, timeout: 30_000 });
    execSync('git commit -m "add vendored"', { cwd: tmpDir, timeout: 30_000 });

    run(`${TEAM_INIT} optional`, { cwd: tmpDir });

    // Re-create vendored dir to simulate re-run scenario
    fs.mkdirSync(vendoredDir, { recursive: true });
    fs.writeFileSync(path.join(vendoredDir, 'VERSION'), '0.14.0.0');
    run(`${TEAM_INIT} optional`, { cwd: tmpDir });

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.claude\/skills\/gstack\//g);
    expect(matches).toHaveLength(1);
  });
});

describe('setup --team / --no-team / -q', () => {
  // Run the real installer from a private payload: setup can rebuild binaries,
  // regenerate source, and install skills. None may target this test's checkout.
  function withSetup(check: (fixture: { setup: string; cwd: string; env: NodeJS.ProcessEnv; home: string }) => void): void {
    const protectedPaths = ['setup', 'SKILL.md', 'lib/dom-dump.js', 'design/dist/design'];
    const snapshot = () => protectedPaths.map(rel => {
      const file = path.join(ROOT, rel);
      try {
        const stat = fs.statSync(file, { bigint: true });
        return { rel, mtimeNs: stat.mtimeNs, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rel, missing: true };
        throw error;
      }
    });
    const before = snapshot();
    const tmp = mkTmpDir();
    const cwd = path.join(tmp, 'gstack');
    const home = path.join(tmp, 'home');
    const commands = path.join(tmp, 'commands');
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const write = (rel: string, content: string) => {
      const file = path.join(cwd, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o755 });
    };
    try {
      for (const rel of ['setup', 'VERSION', 'SKILL.md', 'qa/SKILL.md', 'bin/gstack-config', 'bin/gstack-patch-names', 'scripts/resolve-codex-generation-model.ts', 'scripts/models.ts']) {
        const dest = path.join(cwd, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), dest);
      }
      for (const dir of ['browse/src', 'make-pdf/src', 'design/src', 'lib']) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
      // Same executable-presence contract as setup-needs-build.test.ts. These
      // tests cover installer messages, not compiler output or dependency install.
      for (const binary of ['browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf']) {
        write(binary, '#!/bin/sh\nexit 0\n');
        if (process.platform === 'win32') write(`${binary}.exe`, '#!/bin/sh\nexit 0\n');
      }
      write('browse/dist/.build-complete', 'complete\n');
      fs.mkdirSync(commands);
      fs.mkdirSync(home);
      // Only installation/generation prerequisites are stubbed. The model
      // resolver, flag parser, logging, skill registration and completion run
      // unchanged. Unexpected commands (including a build) fail the test.
      fs.writeFileSync(path.join(commands, 'bun'), `#!/usr/bin/env bash
case "$*" in
  'install --frozen-lockfile') exit 0 ;;
  'build --help') echo 'Fixture Bun has no CSO compile flags'; exit 0 ;;
  *'/bin/gstack-migrate-claude-code --install-dir '*)
    [[ "$#" -eq 5 && "$2" = --install-dir && "$4" = --skills-dir ]] || exit 90
    exit 0 ;;
  'run gen:skill-docs --host codex --model gpt-6-astra') mkdir -p .agents/skills; exit 0 ;;
  'run scripts/resolve-codex-generation-model.ts') exec ${quote(process.execPath)} "$@" ;;
  *) echo "Unexpected setup prerequisite: $*" >&2; exit 90 ;;
esac
`, { mode: 0o755 });
      // setup's legacy cache cleanup uses this absolute path even with a
      // private HOME/TMPDIR. Leave the shared cache untouched in this fixture.
      const realRm = Bun.which('rm');
      if (!realRm) throw new Error('rm is required for the setup fixture');
      fs.writeFileSync(path.join(commands, 'rm'), `#!/usr/bin/env bash
if [ "$#" -eq 2 ] && [ "$1" = -f ] && [ "$2" = /tmp/gstack-latest-version ]; then exit 0; fi
exec ${quote(realRm)} "$@"
`, { mode: 0o755 });
      const state = path.join(home, '.gstack');
      const env: NodeJS.ProcessEnv = {
        PATH: `${commands}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        GSTACK_HOME: state, GSTACK_STATE_ROOT: state,
        GSTACK_SKIP_PLAYWRIGHT: '1', GSTACK_SKIP_FONTS: '1', GSTACK_SKIP_COREUTILS: '1', GSTACK_SKIP_ASIDE: '1',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      };
      check({ setup: quote(path.join(cwd, 'setup')), cwd, env, home });
      expect(fs.readFileSync(path.join(state, '.last-setup-version'), 'utf8').trim()).toBe(fs.readFileSync(path.join(cwd, 'VERSION'), 'utf8').trim());
    } finally {
      try { expect(snapshot()).toEqual(before); }
      finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }

  test(
    'setup -q produces no stdout',
    () => withSetup(fixture => {
      const result = runBashScript(`bash ${fixture.setup} -q`, { cwd: fixture.cwd, env: fixture.env, timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
      // -q should suppress informational output (may still have some output from build)
      // The key test is that the "Skill naming:" prompt and "gstack ready" messages are suppressed
      expect(result.stdout).not.toContain('Skill naming:');
      expect(result.stdout).not.toContain('gstack ready');
      expect(fs.realpathSync(path.join(fixture.home, '.claude/skills/gstack'))).toBe(fs.realpathSync(fixture.cwd));
    }),
    180_000,
  );

  test(
    'setup --local prints deprecation warning',
    () => withSetup(fixture => {
      // stderr capture: run via bash redirect so we can capture stderr
      const result = runBashScript(`bash ${fixture.setup} --local -q 2>&1`, { cwd: fixture.cwd, env: fixture.env, timeout: 10000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('deprecated');
      expect(fs.realpathSync(path.join(fixture.cwd, '.claude/skills/qa/SKILL.md'))).toBe(path.join(fs.realpathSync(fixture.cwd), 'qa/SKILL.md'));
    }),
    180_000,
  );
});
