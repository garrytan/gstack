import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

function bashCommand(filePath: string): string {
  return `bash "${filePath.replace(/\\/g, '/')}"`;
}

const SETTINGS_HOOK = bashCommand(path.join(ROOT, 'bin', 'gstack-settings-hook'));
const SESSION_UPDATE = bashCommand(path.join(ROOT, 'bin', 'gstack-session-update'));
const TEAM_INIT = bashCommand(path.join(ROOT, 'bin', 'gstack-team-init'));
const MISSING_PROJECT_REASON =
  'BLOCKED: CLAUDE_PROJECT_DIR is unavailable, so the required gstack hook cannot be loaded.';
const HOOK_LOAD_REASON =
  'BLOCKED: the required gstack hook could not be loaded. Verify project hook setup and retry.';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-team-test-'));
}

function run(cmd: string, opts: { cwd?: string; env?: Record<string, string> } = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? { MSYS_NO_PATHCONV: '1' } : {}),
        ...opts.env,
      },
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

function runHook(
  command: string,
  opts: { cwd: string; env: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(command, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: 'utf-8',
    shell: true,
    timeout: 10000,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

function runHookInPowerShell(
  command: string,
  opts: { cwd: string; env: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      encoding: 'utf-8',
      timeout: 10000,
    },
  );

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

function expectStructuredDeny(
  result: { stdout: string; stderr: string; exitCode: number },
  reason: string,
): void {
  expect(result.exitCode).toBe(0);
  expect(result.stderr.trim()).toBe(reason);
  expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
  expect(JSON.parse(result.stdout)).toEqual({
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
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
    execSync('git init', { cwd: gstackDir });
    execSync('git commit --allow-empty -m "init"', { cwd: gstackDir });
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
    expect(claude).toContain("require('node:os')");
    expect(claude).not.toContain('test -d ~/.claude/skills/gstack/bin');
  });

  test('required: creates enforcement hook', () => {
    const result = run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const hookPath = path.join(tmpDir, '.claude', 'hooks', 'check-gstack.cjs');
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, '.claude', 'hooks', 'check-gstack.sh')),
    ).toBe(false);
    const hook = fs.readFileSync(hookPath, 'utf-8');
    expect(hook).toContain("'use strict'");
    expect(hook).toContain("require('node:fs')");
    expect(hook).toContain(
      'process.env.HOME || process.env.USERPROFILE || os.homedir()',
    );
    expect(hook).toContain('process.env.CLAUDE_PROJECT_DIR');
    expect(hook).toContain("hookEventName: 'PreToolUse'");
    expect(hook).toContain("permissionDecision: 'deny'");
    expect(hook).toContain('BLOCKED: gstack is not installed');
    expect(hook).not.toContain('#!/bin/bash');
    expect(result.stdout).not.toMatch(/git add .*check-gstack\.sh/);
  });

  test('required: registers one shell-neutral project hook', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    const entry = settings.hooks.PreToolUse[0];
    expect(entry.matcher).toBe('Skill|skill');
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0]).not.toHaveProperty('shell');
    expect(entry.hooks[0].command).toBe(
      `node -e "const deny=reason=>{const decision={permissionDecision:'deny',permissionDecisionReason:reason};console.error(reason);console.log(JSON.stringify({...decision,hookSpecificOutput:{hookEventName:'PreToolUse',...decision}}))};const projectDir=process.env.CLAUDE_PROJECT_DIR;if(!projectDir){deny('BLOCKED: CLAUDE_PROJECT_DIR is unavailable, so the required gstack hook cannot be loaded.')}else{try{require(require('node:path').join(projectDir, '.claude', 'hooks', 'check-gstack.cjs'))}catch{deny('BLOCKED: the required gstack hook could not be loaded. Verify project hook setup and retry.')}}"`,
    );
    expect(entry.hooks[0].command).not.toMatch(
      /\$CLAUDE_PROJECT_DIR|\$env:CLAUDE_PROJECT_DIR|%CLAUDE_PROJECT_DIR%/,
    );
    expect(entry.hooks[0].command).not.toContain("permissionDecision:'allow'");
  });

  test('required: hook allows with valid empty JSON when gstack is installed', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const fakeHome = path.join(tmpDir, 'home');
    const nestedCwd = path.join(tmpDir, 'nested', 'working', 'directory');
    fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', 'gstack', 'bin'), {
      recursive: true,
    });
    fs.mkdirSync(nestedCwd, { recursive: true });

    const result = runHook(command, {
      cwd: nestedCwd,
      env: {
        CLAUDE_PROJECT_DIR: tmpDir,
        HOME: fakeHome,
        USERPROFILE: path.join(tmpDir, 'unused-userprofile'),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  test('required: missing project env denies through the platform default shell', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;

    const result = runHook(command, {
      cwd: tmpDir,
      env: { CLAUDE_PROJECT_DIR: '' },
    });

    expectStructuredDeny(result, MISSING_PROJECT_REASON);
  });

  test('required: missing project env denies through PowerShell', () => {
    if (process.platform !== 'win32') return;

    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;

    const result = runHookInPowerShell(command, {
      cwd: tmpDir,
      env: { CLAUDE_PROJECT_DIR: '' },
    });

    expectStructuredDeny(result, MISSING_PROJECT_REASON);
  }, 30_000);

  test('required: stale project paths deny through the platform default shell', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const existingWithoutHook = path.join(tmpDir, 'existing-without-hook');
    fs.mkdirSync(existingWithoutHook);

    for (const projectDir of [
      path.join(tmpDir, 'nonexistent-project'),
      existingWithoutHook,
    ]) {
      const result = runHook(command, {
        cwd: tmpDir,
        env: { CLAUDE_PROJECT_DIR: projectDir },
      });

      expectStructuredDeny(result, HOOK_LOAD_REASON);
      expect(result.stderr).not.toContain(projectDir);
    }
  });

  test('required: stale project paths deny through PowerShell', () => {
    if (process.platform !== 'win32') return;

    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const existingWithoutHook = path.join(tmpDir, 'powershell-without-hook');
    fs.mkdirSync(existingWithoutHook);

    for (const projectDir of [
      path.join(tmpDir, 'powershell-nonexistent'),
      existingWithoutHook,
    ]) {
      const result = runHookInPowerShell(command, {
        cwd: tmpDir,
        env: { CLAUDE_PROJECT_DIR: projectDir },
      });

      expectStructuredDeny(result, HOOK_LOAD_REASON);
      expect(result.stderr).not.toContain(projectDir);
    }
  }, 30_000);

  test('required: hook runs in PowerShell with USERPROFILE home fallback', () => {
    if (process.platform !== 'win32') return;

    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const fakeHome = path.join(tmpDir, 'powershell-home');
    fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', 'gstack', 'bin'), {
      recursive: true,
    });

    const result = runHookInPowerShell(command, {
      cwd: tmpDir,
      env: {
        CLAUDE_PROJECT_DIR: tmpDir,
        HOME: '',
        USERPROFILE: fakeHome,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({});
  }, 30_000);

  test('required: missing gstack returns an intentional deny, not a hook error', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const fakeHome = path.join(tmpDir, 'home-without-gstack');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runHook(command, {
      cwd: tmpDir,
      env: {
        CLAUDE_PROJECT_DIR: tmpDir,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('BLOCKED: gstack is not installed globally.');
    expect(result.stderr).toContain('git clone --depth 1');
    const decision = JSON.parse(result.stdout);
    expect(decision).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining(
        'Then restart your AI coding tool.',
      ),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining(
          'Then restart your AI coding tool.',
        ),
      },
    });
  });

  test('required: install verification errors return a structured deny', () => {
    run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const fakeHome = path.join(tmpDir, 'unreadable-home');
    const preload = path.join(tmpDir, 'fail-gstack-stat.cjs');
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(
      preload,
      `'use strict';
const fs = require('node:fs');
const original = fs.statSync;
fs.statSync = function (target, ...args) {
  if (String(target).replace(/\\\\/g, '/').includes('skills/gstack/bin')) {
    const error = new Error('injected verification failure');
    error.code = 'EACCES';
    throw error;
  }
  return original.call(this, target, ...args);
};
`,
    );

    const result = runHook(command, {
      cwd: tmpDir,
      env: {
        CLAUDE_PROJECT_DIR: tmpDir,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        NODE_OPTIONS: `--require=${preload}`,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      'BLOCKED: the global gstack install could not be verified.',
    );
    expect(result.stderr).not.toContain('injected verification failure');
    const decision = JSON.parse(result.stdout);
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toContain(
      'BLOCKED: the global gstack install could not be verified.',
    );
    expect(decision.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.permissionDecisionReason,
    });
  });

  test('required: rerun removes a legacy Bash hook without touching other hooks', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    const legacyHook = path.join(hooksDir, 'check-gstack.sh');
    const unrelatedHook = path.join(hooksDir, 'check-project.cjs');
    const unrelatedHookContents = "console.log('project hook');\n";
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(legacyHook, '#!/bin/bash\n');
    fs.writeFileSync(unrelatedHook, unrelatedHookContents);
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Skill',
              hooks: [{
                type: 'command',
                command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/check-gstack.sh"',
              }],
            },
          ],
        },
      }),
    );
    execSync('git add .claude', { cwd: tmpDir });
    execSync('git commit -m "add legacy hook"', { cwd: tmpDir });

    const migration = run(`${TEAM_INIT} required`, { cwd: tmpDir });
    expect(fs.existsSync(legacyHook)).toBe(false);
    expect(fs.readFileSync(unrelatedHook, 'utf-8')).toBe(unrelatedHookContents);
    const suggestedGitAdd = migration.stdout
      .split('\n')
      .find(line => line.startsWith('  git add '))
      ?.trim();
    if (!suggestedGitAdd) {
      throw new Error('gstack-team-init did not print a git add command');
    }
    expect(suggestedGitAdd.split(/\s+/)).toContain(
      '.claude/hooks/check-gstack.sh',
    );
    execSync(suggestedGitAdd, { cwd: tmpDir });
    execSync('git commit -m "migrate required hook"', { cwd: tmpDir });
    expect(
      execSync('git status --short', { cwd: tmpDir, encoding: 'utf-8' }),
    ).toBe('');

    const rerun = run(`${TEAM_INIT} required`, { cwd: tmpDir });
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(fs.existsSync(legacyHook)).toBe(false);
    expect(fs.readFileSync(unrelatedHook, 'utf-8')).toBe(unrelatedHookContents);
    const rerunGitAdd = rerun.stdout
      .split('\n')
      .find(line => line.startsWith('  git add '))
      ?.trim();
    if (!rerunGitAdd) {
      throw new Error('gstack-team-init rerun did not print a git add command');
    }
    expect(rerunGitAdd.split(/\s+/)).not.toContain(
      '.claude/hooks/check-gstack.sh',
    );
    execSync(rerunGitAdd, { cwd: tmpDir });
    expect(
      execSync('git status --short', { cwd: tmpDir, encoding: 'utf-8' }),
    ).toBe('');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Skill|skill');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      'check-gstack.cjs',
    );
  }, 30_000);

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
    fs.symlinkSync(
      targetDir,
      path.join(skillsDir, 'gstack'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

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
      const result = run(`${bashCommand(path.join(ROOT, 'setup'))} -q`, { cwd: ROOT });
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
      const result = run(`${bashCommand(path.join(ROOT, 'setup'))} --local -q 2>&1`, { cwd: ROOT });
      expect(result.stdout).toContain('deprecated');
    },
    180_000,
  );
});
