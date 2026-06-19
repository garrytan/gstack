/**
 * gstack-settings-hook statusline surface.
 *
 * Verifies set-statusline / remove-statusline: install into an empty slot,
 * idempotent no-op, never clobber a non-gstack statusLine (exit 3) without
 * --force, --force override, update-our-own, and remove-only-ours. This is the
 * machinery `./setup` and `gstack-uninstall` use to wire bin/gstack-statusline
 * into ~/.claude/settings.json.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SETTINGS_HOOK = path.join(ROOT, 'bin', 'gstack-settings-hook');

const GSTACK_CMD = 'bash "/home/u/.claude/skills/gstack/bin/gstack-statusline"';
const FOREIGN_CMD = 'bash ~/.config/my-custom-statusline.sh';

let tmpDir: string;
let settingsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sl-'));
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

function writeSettings(obj: any): void {
  fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2) + '\n');
}

// ----------------------------------------------------------------------
// set-statusline
// ----------------------------------------------------------------------

describe('set-statusline', () => {
  test('installs into an empty slot (no settings file yet)', () => {
    const r = run(['set-statusline', '--command', GSTACK_CMD]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('installed');
    const s = settings();
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toBe(GSTACK_CMD);
  });

  test('preserves unrelated settings when installing', () => {
    writeSettings({ theme: 'dark', permissions: { deny: [] } });
    const r = run(['set-statusline', '--command', GSTACK_CMD]);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.theme).toBe('dark');
    expect(s.permissions).toEqual({ deny: [] });
    expect(s.statusLine.command).toBe(GSTACK_CMD);
  });

  test('is idempotent when our statusLine is already current', () => {
    run(['set-statusline', '--command', GSTACK_CMD]);
    const r = run(['set-statusline', '--command', GSTACK_CMD]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no change');
  });

  test('updates our own statusLine when the command changes', () => {
    run(['set-statusline', '--command', GSTACK_CMD]);
    const updated = GSTACK_CMD.replace('gstack-statusline', 'gstack-statusline" --verbose');
    const r = run(['set-statusline', '--command', updated]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('installed');
    expect(settings().statusLine.command).toBe(updated);
  });

  test('refuses to clobber a non-gstack statusLine (exit 3, unchanged)', () => {
    writeSettings({ statusLine: { type: 'command', command: FOREIGN_CMD } });
    const r = run(['set-statusline', '--command', GSTACK_CMD]);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('non-gstack statusLine');
    // The user's statusLine is left exactly as it was.
    expect(settings().statusLine.command).toBe(FOREIGN_CMD);
  });

  test('--force replaces a non-gstack statusLine', () => {
    writeSettings({ statusLine: { type: 'command', command: FOREIGN_CMD } });
    const r = run(['set-statusline', '--command', GSTACK_CMD, '--force']);
    expect(r.exitCode).toBe(0);
    expect(settings().statusLine.command).toBe(GSTACK_CMD);
  });

  test('errors without --command', () => {
    const r = run(['set-statusline']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--command');
  });
});

// ----------------------------------------------------------------------
// remove-statusline
// ----------------------------------------------------------------------

describe('remove-statusline', () => {
  test('removes our own statusLine', () => {
    run(['set-statusline', '--command', GSTACK_CMD]);
    const r = run(['remove-statusline']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('removed gstack statusLine');
    expect(settings().statusLine).toBeUndefined();
  });

  test('leaves a non-gstack statusLine untouched', () => {
    writeSettings({ statusLine: { type: 'command', command: FOREIGN_CMD } });
    const r = run(['remove-statusline']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no gstack statusLine to remove');
    expect(settings().statusLine.command).toBe(FOREIGN_CMD);
  });

  test('is a no-op with no settings file', () => {
    const r = run(['remove-statusline']);
    expect(r.exitCode).toBe(0);
  });
});
