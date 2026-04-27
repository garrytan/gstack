import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
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

describe('gstack-team-init', () => {
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
    execSync('git add .claude/skills/gstack/', { cwd: tmpDir });
    execSync('git commit -m "add vendored gstack"', { cwd: tmpDir });

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
    execSync('git add .claude/skills/gstack/', { cwd: tmpDir });
    execSync('git commit -m "add vendored"', { cwd: tmpDir });

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
  // `./setup` does a full install + build + skill regeneration. On a cold cache
  // it routinely takes 60-90s. Give both tests a 3-minute budget so CI doesn't
  // report pre-existing timeouts as failures.
  test(
    'setup -q produces no stdout',
    () => {
      const result = run(`${path.join(ROOT, 'setup')} -q`, { cwd: ROOT });
      // -q should suppress informational output (may still have some output from build)
      // The key test is that the "Skill naming:" prompt and "gstack ready" messages are suppressed
      expect(result.stdout).not.toContain('Skill naming:');
      expect(result.stdout).not.toContain('gstack ready');
    },
    180_000,
  );

  test(
    'setup --local prints deprecation warning',
    () => {
      // stderr capture: run via bash redirect so we can capture stderr
      const result = run(`bash -c '${path.join(ROOT, 'setup')} --local -q 2>&1'`, { cwd: ROOT });
      expect(result.stdout).toContain('deprecated');
    },
    180_000,
  );
});
