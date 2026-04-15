import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SETTINGS_HOOK = path.join(ROOT, 'bin', 'jstack-settings-hook');
const SESSION_UPDATE = path.join(ROOT, 'bin', 'jstack-session-update');
const TEAM_INIT = path.join(ROOT, 'bin', 'jstack-team-init');

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-team-test-'));
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

describe('jstack-settings-hook', () => {
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
    const result = run(`${SETTINGS_HOOK} add /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('/path/to/jstack-session-update');
  });

  test('add preserves existing settings', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ effortLevel: 'high', permissions: { defaultMode: 'auto' } }, null, 2));
    const result = run(`${SETTINGS_HOOK} add /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.effortLevel).toBe('high');
    expect(settings.permissions.defaultMode).toBe('auto');
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test('add deduplicates (running twice does not double-add)', () => {
    run(`${SETTINGS_HOOK} add /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    run(`${SETTINGS_HOOK} add /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test('remove removes the hook', () => {
    run(`${SETTINGS_HOOK} add /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    const result = run(`${SETTINGS_HOOK} remove /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks).toBeUndefined();
  });

  test('remove is safe when settings.json does not exist', () => {
    const result = run(`${SETTINGS_HOOK} remove /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    expect(result.exitCode).toBe(0);
  });

  test('remove preserves other hooks', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/path/to/jstack-session-update' }] },
          { hooks: [{ type: 'command', command: '/other/hook' }] },
        ],
      },
    }, null, 2));
    run(`${SETTINGS_HOOK} remove /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('/other/hook');
  });

  test('atomic write (no partial file on success)', () => {
    run(`${SETTINGS_HOOK} add /path/to/jstack-session-update`, {
      env: { JSTACK_SETTINGS_FILE: settingsFile },
    });
    // .tmp file should not exist after successful write
    expect(fs.existsSync(settingsFile + '.tmp')).toBe(false);
    // File should be valid JSON
    expect(() => JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).not.toThrow();
  });
});

describe('jstack-session-update', () => {
  let tmpDir: string;
  let jstackDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    jstackDir = path.join(tmpDir, 'jstack');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(jstackDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Init a git repo to pass the .git guard
    execSync('git init', { cwd: jstackDir });
    execSync('git commit --allow-empty -m "init"', { cwd: jstackDir });
    fs.writeFileSync(path.join(jstackDir, 'VERSION'), '0.1.0');

    // Create a minimal jstack-config that returns auto_upgrade=true
    const binDir = path.join(jstackDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'jstack-config'), '#!/bin/bash\necho "true"');
    fs.chmodSync(path.join(binDir, 'jstack-config'), 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('exits 0 when .git is missing', () => {
    fs.rmSync(path.join(jstackDir, '.git'), { recursive: true });
    const result = run(SESSION_UPDATE, {
      env: { JSTACK_DIR: jstackDir, JSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
  });

  test('exits 0 when auto_upgrade is not true', () => {
    // Override jstack-config to return false
    fs.writeFileSync(path.join(jstackDir, 'bin', 'jstack-config'), '#!/bin/bash\necho "false"');
    const result = run(SESSION_UPDATE, {
      env: { JSTACK_DIR: jstackDir, JSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
  });

  test('throttle: skips when checked recently', () => {
    // Write a recent throttle timestamp
    const throttleFile = path.join(stateDir, '.last-session-update');
    fs.writeFileSync(throttleFile, String(Math.floor(Date.now() / 1000)));

    const result = run(SESSION_UPDATE, {
      env: { JSTACK_DIR: jstackDir, JSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
    // No log file should be created (throttled before forking)
  });

  test('always exits 0 (non-fatal)', () => {
    // Even with a broken setup, should exit 0
    const result = run(SESSION_UPDATE, {
      env: { JSTACK_DIR: '/nonexistent/path', JSTACK_STATE_DIR: stateDir },
    });
    expect(result.exitCode).toBe(0);
  });
});

describe('jstack-team-init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    execSync('git init', { cwd: tmpDir });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir });
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
    expect(claude).toContain('## jstack (recommended)');
    expect(claude).toContain('./setup --team');
  });

  test('required: creates CLAUDE.md with required section', () => {
    const result = run(`${TEAM_INIT} required`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('## jstack (REQUIRED');
    expect(claude).toContain('JSTACK_MISSING');
  });

  test('required: creates enforcement hook', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const hookPath = path.join(tmpDir, '.claude', 'hooks', 'check-jstack.sh');
    expect(fs.existsSync(hookPath)).toBe(true);
    const hook = fs.readFileSync(hookPath, 'utf-8');
    expect(hook).toContain('BLOCKED: jstack is not installed');
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
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('check-jstack');
  });

  test('idempotent: running twice does not duplicate CLAUDE.md section', () => {
    run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const matches = claude.match(/## jstack/g);
    expect(matches).toHaveLength(1);
  });

  test('removes vendored copy when present', () => {
    // Create a fake vendored jstack with VERSION file
    const vendoredDir = path.join(tmpDir, '.claude', 'skills', 'jstack');
    fs.mkdirSync(vendoredDir, { recursive: true });
    fs.writeFileSync(path.join(vendoredDir, 'VERSION'), '0.14.0.0');
    fs.writeFileSync(path.join(vendoredDir, 'README.md'), 'vendored');
    // Track it in git
    execSync('git add .claude/skills/jstack/', { cwd: tmpDir });
    execSync('git commit -m "add vendored jstack"', { cwd: tmpDir });

    const result = run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Found vendored jstack copy');
    expect(result.stdout).toContain('Removed vendored copy');
    // Vendored dir should be gone
    expect(fs.existsSync(vendoredDir)).toBe(false);
    // .gitignore should have the entry
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.claude/skills/jstack/');
  });

  test('skips when no vendored copy present', () => {
    const result = run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found vendored jstack copy');
  });

  test('skips when .claude/skills/jstack is a symlink', () => {
    // Create a symlink (not a real vendored copy)
    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const targetDir = mkTmpDir();
    fs.writeFileSync(path.join(targetDir, 'VERSION'), '0.14.0.0');
    fs.symlinkSync(targetDir, path.join(skillsDir, 'jstack'));

    const result = run(`${TEAM_INIT} optional`, { cwd: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found vendored jstack copy');
    // Symlink should still exist
    expect(fs.lstatSync(path.join(skillsDir, 'jstack')).isSymbolicLink()).toBe(true);
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  test('does not duplicate .gitignore entry on re-run', () => {
    // Create vendored copy
    const vendoredDir = path.join(tmpDir, '.claude', 'skills', 'jstack');
    fs.mkdirSync(vendoredDir, { recursive: true });
    fs.writeFileSync(path.join(vendoredDir, 'VERSION'), '0.14.0.0');
    execSync('git add .claude/skills/jstack/', { cwd: tmpDir });
    execSync('git commit -m "add vendored"', { cwd: tmpDir });

    run(`${TEAM_INIT} optional`, { cwd: tmpDir });

    // Re-create vendored dir to simulate re-run scenario
    fs.mkdirSync(vendoredDir, { recursive: true });
    fs.writeFileSync(path.join(vendoredDir, 'VERSION'), '0.14.0.0');
    run(`${TEAM_INIT} optional`, { cwd: tmpDir });

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.claude\/skills\/jstack\//g);
    expect(matches).toHaveLength(1);
  });
});

describe('setup --team / --no-team / -q', () => {
  test('setup -q produces no stdout', () => {
    const result = run(`${path.join(ROOT, 'setup')} -q`, { cwd: ROOT });
    // -q should suppress informational output (may still have some output from build)
    // The key test is that the "Skill naming:" prompt and "jstack ready" messages are suppressed
    expect(result.stdout).not.toContain('Skill naming:');
    expect(result.stdout).not.toContain('jstack ready');
  });

  test('setup --local prints deprecation warning', () => {
    // stderr capture: run via bash redirect so we can capture stderr
    const result = run(`bash -c '${path.join(ROOT, 'setup')} --local -q 2>&1'`, { cwd: ROOT });
    expect(result.stdout).toContain('deprecated');
  });
});
