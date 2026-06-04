/**
 * gstack-settings-hook schema-aware surface (T3 plan-tune cathedral).
 *
 * Verifies add-event / remove-source / diff-event / rollback / list-sources
 * for PreToolUse + PostToolUse registration. Existing team-mode.test.ts
 * covers the legacy `add <cmd>` / `remove <cmd>` shape; this file only
 * covers the new surface introduced for the plan-tune cathedral.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SETTINGS_HOOK = path.join(ROOT, 'bin', 'gstack-settings-hook');

let tmpDir: string;
let settingsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-shsa-'));
  settingsFile = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync([SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' '), {
      env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile },
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

function settings(): any {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
}

// ----------------------------------------------------------------------
// add-event
// ----------------------------------------------------------------------

describe('add-event', () => {
  test('registers a PreToolUse hook with matcher + source tag', () => {
    const r = run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-preference-hook',
      '--source', 'plan-tune-cathedral',
      '--timeout', '5',
    ]);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('(AskUserQuestion|mcp__.*__AskUserQuestion)');
    expect(s.hooks.PreToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/abs/path/to/question-preference-hook');
    expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
  });

  test('registers a PostToolUse hook independently of PreToolUse', () => {
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/pre',
      '--source', 'plan-tune-cathedral',
    ]);
    const r = run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/post',
      '--source', 'plan-tune-cathedral',
    ]);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/pre');
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('/post');
  });

  test('idempotent: re-adding same (event, matcher, source) updates in place', () => {
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/v1',
      '--source', 'plan-tune-cathedral',
    ]);
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/v2',
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/v2');
  });

  test('preserves unrelated existing hooks', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: '/user-own-hook' }],
            },
          ],
        },
      }, null, 2),
    );
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack-hook',
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PreToolUse).toHaveLength(2);
    // User's Bash hook still present
    const bash = s.hooks.PreToolUse.find((e: any) => e.matcher === 'Bash');
    expect(bash).toBeDefined();
    expect(bash.hooks[0].command).toBe('/user-own-hook');
  });

  test('writes a timestamped backup before mutating', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ existing: 'value' }));
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack',
      '--source', 'plan-tune-cathedral',
    ]);
    const backups = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('settings.json.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupContent = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8'));
    expect(backupContent.existing).toBe('value');
    expect(backupContent.hooks).toBeUndefined();
  });

  test('rejects invalid --event', () => {
    const r = run([
      'add-event',
      '--event', 'NotAnEvent',
      '--command', '/x',
      '--source', 'plan-tune',
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --event/);
  });
});

// ----------------------------------------------------------------------
// remove-source
// ----------------------------------------------------------------------

describe('remove-source', () => {
  test('removes all entries with a given source tag, leaves others alone', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ command: '/keep-me' }] },
          ],
        },
      }),
    );
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/a',
      '--source', 'plan-tune-cathedral',
    ]);
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/b',
      '--source', 'plan-tune-cathedral',
    ]);
    const r = run(['remove-source', '--source', 'plan-tune-cathedral']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed 2 hook/);
    const s = settings();
    expect(s.hooks.PostToolUse).toBeUndefined();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/keep-me');
  });

  test('safely no-ops when settings.json missing', () => {
    const r = run(['remove-source', '--source', 'plan-tune-cathedral']);
    expect(r.exitCode).toBe(0);
  });
});

// ----------------------------------------------------------------------
// diff-event
// ----------------------------------------------------------------------

describe('diff-event', () => {
  test('emits BEFORE + AFTER without mutating settings.json', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ existing: 'value' }));
    const r = run([
      'diff-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack',
      '--source', 'plan-tune-cathedral',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('--- BEFORE');
    expect(r.stdout).toContain('--- AFTER');
    expect(r.stdout).toContain('plan-tune-cathedral');
    // Settings file unchanged.
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({ existing: 'value' });
  });
});

// ----------------------------------------------------------------------
// rollback
// ----------------------------------------------------------------------

describe('rollback', () => {
  test('restores latest backup', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ original: true }));
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/gstack',
      '--source', 'plan-tune-cathedral',
    ]);
    expect(settings().hooks).toBeDefined();
    const r = run(['rollback']);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.original).toBe(true);
    expect(s.hooks).toBeUndefined();
  });

  test('fails clearly when no backup pointer exists', () => {
    const r = run(['rollback']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no backup pointer/);
  });
});

// ----------------------------------------------------------------------
// list-sources
// ----------------------------------------------------------------------

describe('list-sources', () => {
  test('shows source-tagged hooks across all events', () => {
    run([
      'add-event',
      '--event', 'PreToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/pre',
      '--source', 'plan-tune-cathedral',
    ]);
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', 'AskUserQuestion',
      '--command', '/post',
      '--source', 'plan-tune-cathedral',
    ]);
    const r = run(['list-sources']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('PreToolUse');
    expect(r.stdout).toContain('PostToolUse');
    expect(r.stdout).toContain('plan-tune-cathedral');
  });

  test('empty when no settings file', () => {
    const r = run(['list-sources']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no settings file/);
  });
});
