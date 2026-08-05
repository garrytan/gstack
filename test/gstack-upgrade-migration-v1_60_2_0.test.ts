import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v1.60.2.0.sh');
const SETUP = path.join(ROOT, 'setup');
const MATCHER = '(AskUserQuestion|mcp__.*__AskUserQuestion)';
const PREF = path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-preference-hook');
const LOG = path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-log-hook');
const FALLBACK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'auq-error-fallback-hook');

let home: string;
let settingsFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-auq-migration-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  settingsFile = path.join(home, '.claude', 'settings.json');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    ...extraEnv,
  };
  return spawnSync('bash', [MIGRATION], { env, encoding: 'utf-8' });
}

function writeConfig(value: string): void {
  fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), `plan_tune_hooks: ${value}\n`);
}

function hook(command: string) {
  return { matcher: MATCHER, hooks: [{ type: 'command', command, timeout: 5 }] };
}

function settings(): any {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
}

function commandCount(entries: any[], command: string): number {
  return entries.filter((entry) =>
    entry.hooks?.some((registered: any) => registered.command === command),
  ).length;
}

describe('v1.60.2.0 AskUserQuestion hook migration', () => {
  test('collapses three stripped copies of every hook and preserves user hooks', () => {
    const original = {
      permissions: { allow: ['Bash(git status)'] },
      hooks: {
        PreToolUse: [hook(PREF), hook(PREF), hook(PREF), hook('/user/pre-hook')],
        PostToolUse: [
          hook(LOG), hook(LOG), hook(LOG),
          hook(FALLBACK), hook(FALLBACK), hook(FALLBACK),
          hook('/user/post-hook'),
        ],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2));

    const result = run({ CONDUCTOR_PORT: '55070' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('hooks normalized');

    const updated = settings();
    expect(commandCount(updated.hooks.PreToolUse, PREF)).toBe(1);
    expect(commandCount(updated.hooks.PostToolUse, LOG)).toBe(1);
    expect(commandCount(updated.hooks.PostToolUse, FALLBACK)).toBe(1);
    expect(commandCount(updated.hooks.PreToolUse, '/user/pre-hook')).toBe(1);
    expect(commandCount(updated.hooks.PostToolUse, '/user/post-hook')).toBe(1);
    expect(updated.permissions).toEqual(original.permissions);

    const prefEntry = updated.hooks.PreToolUse.find((entry: any) =>
      entry.hooks.some((registered: any) => registered.command === PREF));
    const fallbackEntry = updated.hooks.PostToolUse.find((entry: any) =>
      entry.hooks.some((registered: any) => registered.command === FALLBACK));
    expect(prefEntry._gstack_source).toBe('plan-tune-cathedral');
    expect(fallbackEntry._gstack_source).toBe('auq-error-fallback');
    expect(fs.existsSync(path.join(home, '.gstack', '.migrations', 'v1.60.2.0.done'))).toBe(true);

    const backups = fs.readdirSync(path.join(home, '.claude'))
      .filter((file) => file.startsWith('settings.json.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(3);
    expect(backups.some((file) =>
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, '.claude', file), 'utf-8'))) ===
        JSON.stringify(original),
    )).toBe(true);
  });

  test('respects an explicit opt-out even inside Conductor', () => {
    writeConfig('no');
    const original = { hooks: { PreToolUse: [hook(PREF), hook(PREF)] } };
    fs.writeFileSync(settingsFile, JSON.stringify(original));
    const result = run({ CONDUCTOR_PORT: '55070' });
    expect(result.status).toBe(0);
    expect(settings()).toEqual(original);
    expect(fs.existsSync(path.join(home, '.gstack', '.migrations', 'v1.60.2.0.done'))).toBe(true);
  });

  test('does not install hooks outside Conductor without an explicit opt-in', () => {
    const original = { existing: true };
    fs.writeFileSync(settingsFile, JSON.stringify(original));
    expect(run().status).toBe(0);
    expect(settings()).toEqual(original);
  });

  test('explicit opt-in normalizes outside Conductor and reruns idempotently', () => {
    writeConfig('yes');
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [hook(PREF), hook(PREF)] } }));
    expect(run().status).toBe(0);
    const afterFirst = fs.readFileSync(settingsFile, 'utf-8');
    const backupsAfterFirst = fs.readdirSync(path.join(home, '.claude'))
      .filter((file) => file.startsWith('settings.json.bak.')).length;

    expect(run().status).toBe(0);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(afterFirst);
    const backupsAfterSecond = fs.readdirSync(path.join(home, '.claude'))
      .filter((file) => file.startsWith('settings.json.bak.')).length;
    expect(backupsAfterSecond).toBe(backupsAfterFirst);
  });

  test('normalization failure exits nonzero and remains retryable', () => {
    const failed = run({ CONDUCTOR_PORT: '55070', PATH: '/usr/bin:/bin' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('migration will retry later');
    expect(fs.existsSync(path.join(home, '.gstack', '.migrations', 'v1.60.2.0.done'))).toBe(false);

    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {} }));
    const retried = run({ CONDUCTOR_PORT: '55070' });
    expect(retried.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.gstack', '.migrations', 'v1.60.2.0.done'))).toBe(true);
  });

  test('setup advances its version marker only after migrations succeed', () => {
    const source = fs.readFileSync(SETUP, 'utf-8');
    expect(source).toContain('MIGRATIONS_OK=1');
    expect(source).toContain('MIGRATIONS_OK=0');
    expect(source).toContain('[ "$CURRENT_VERSION" != "unknown" ] && [ "$MIGRATIONS_OK" -eq 1 ]');
    expect(source).toContain('retaining setup version $LAST_SETUP_VERSION until migrations succeed');
  });
});
