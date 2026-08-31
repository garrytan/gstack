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

  test('dedup includes command: same (event, matcher, command) with different source updates in place', () => {
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-log-hook',
      '--source', 'source-A',
      '--timeout', '5',
    ]);
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-log-hook',
      '--source', 'source-B',
      '--timeout', '5',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('source-B');
  });

  test('dedup includes command: untagged entry with same command is updated not duplicated', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: '(AskUserQuestion|mcp__.*__AskUserQuestion)',
              hooks: [{ type: 'command', command: '/abs/path/to/question-log-hook', timeout: 5 }],
            },
          ],
        },
      }, null, 2),
    );
    run([
      'add-event',
      '--event', 'PostToolUse',
      '--matcher', '(AskUserQuestion|mcp__.*__AskUserQuestion)',
      '--command', '/abs/path/to/question-log-hook',
      '--source', 'plan-tune-cathedral',
      '--timeout', '5',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
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
// ensure-event: duplicate (event, source) collapse
// ----------------------------------------------------------------------

describe('ensure-event collapses duplicate (event, source) entries', () => {
  test('two same-source entries from the old matcher-keyed dedup collapse to ONE updated entry', () => {
    // Pre-existing installs can carry two entries with the same
    // (event, _gstack_source) — the old dedup keyed on the matcher too, so a
    // matcher change pushed a second registration. `.find()` updated only the
    // first and left the stale twin running forever.
    const { spawnSync } = require('child_process');
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          { _gstack_source: 'plan-tune-cathedral', matcher: 'OldMatcherA', hooks: [{ type: 'command', command: '/old-a', timeout: 5 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/user-own-hook' }] },
          { _gstack_source: 'plan-tune-cathedral', matcher: 'OldMatcherB', hooks: [{ type: 'command', command: '/old-b', timeout: 5 }] },
        ],
      },
    }, null, 2));

    const r = spawnSync('bash', [
      SETTINGS_HOOK, 'ensure-event',
      '--event', 'PostToolUse',
      '--matcher', 'NewMatcher',
      '--command', '/canonical',
      '--source', 'plan-tune-cathedral',
      '--timeout', '5',
    ], { env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile }, encoding: 'utf-8', timeout: 15_000 });

    expect(r.status).toBe(0);
    // The collapse is reported on stderr, never silent.
    expect(r.stderr).toContain('collapsed 1 duplicate');
    const s = settings();
    const mine = s.hooks.PostToolUse.filter((e: any) => e._gstack_source === 'plan-tune-cathedral');
    expect(mine).toHaveLength(1); // ONE canonical entry — the stale twin is gone
    expect(mine[0].matcher).toBe('NewMatcher');
    expect(mine[0].hooks[0].command).toBe('/canonical');
    // Unrelated user hook untouched.
    const bash = s.hooks.PostToolUse.find((e: any) => e.matcher === 'Bash');
    expect(bash.hooks[0].command).toBe('/user-own-hook');
    expect(s.hooks.PostToolUse).toHaveLength(2);
  });

  test('no duplicates → no collapse message, single entry updated as before', () => {
    const { spawnSync } = require('child_process');
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          { _gstack_source: 'plan-tune-cathedral', matcher: 'OldMatcher', hooks: [{ type: 'command', command: '/old', timeout: 5 }] },
        ],
      },
    }, null, 2));

    const r = spawnSync('bash', [
      SETTINGS_HOOK, 'ensure-event',
      '--event', 'PostToolUse',
      '--matcher', 'NewMatcher',
      '--command', '/new',
      '--source', 'plan-tune-cathedral',
      '--timeout', '5',
    ], { env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile }, encoding: 'utf-8', timeout: 15_000 });

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('collapsed');
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('/new');
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

// ----------------------------------------------------------------------
// Phantom-hooks heal surface (v1.67.2): KNOWN_HOOKS identity table,
// per-item mutation, prune-stale, mutation lock, fail-closed parse.
//
// Ownership is intrinsic (basename + relpath suffix + event/matcher against
// the fixed table) because Claude Code strips the _gstack_source key when it
// rewrites settings.json — tag-only dedupe is what let every Conductor
// worktree append a fresh dead entry.
// ----------------------------------------------------------------------

const AUQ_MATCHER = '(AskUserQuestion|mcp__.*__AskUserQuestion)';
const HOOK_NAMES = [
  'question-log-hook',
  'question-preference-hook',
  'auq-error-fallback-hook',
  'timeline-stop-hook',
];

/** run() with hermetic gstack-config state (prune-stale consults plan_tune_hooks). */
function runIso(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const stdout = execSync([SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' '), {
      env: {
        ...process.env,
        GSTACK_SETTINGS_FILE: settingsFile,
        GSTACK_STATE_ROOT: tmpDir,
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

/** A fake stable install with executable hooks, under `base`. */
function mkCanon(base: string, name = 'canon'): string {
  const canon = path.join(base, name);
  fs.mkdirSync(path.join(canon, 'hosts', 'claude', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(canon, 'bin'), { recursive: true });
  for (const h of HOOK_NAMES) {
    const p = path.join(canon, 'hosts', 'claude', 'hooks', h);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  }
  const su = path.join(canon, 'bin', 'gstack-session-update');
  fs.writeFileSync(su, '#!/bin/sh\n');
  fs.chmodSync(su, 0o755);
  return canon;
}

function hookEntry(cmd: string, matcher?: string, src?: string, extraItems: any[] = []) {
  const e: any = { hooks: [...extraItems, { type: 'command', command: cmd, timeout: 5 }] };
  if (matcher) e.matcher = matcher;
  if (src) e._gstack_source = src;
  return e;
}

function backups(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak.'));
}

describe('add-event: per-item identity re-point', () => {
  test('tag-stripped stale worktree path is re-pointed in place, tag restored', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { PostToolUse: [hookEntry('/dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER)] },
    }, null, 2));
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral', '--timeout', '5',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`${canon}/hosts/claude/hooks/question-log-hook`);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
  });

  test('foreign path with a gstack basename is NOT claimed (wrong relpath suffix)', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { PostToolUse: [hookEntry('/home/u/myhooks/question-log-hook', AUQ_MATCHER)] },
    }, null, 2));
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('/home/u/myhooks/question-log-hook');
  });

  test('mixed entry: only the gstack item (index > 0) is replaced; the user item survives', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry(
          '/dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER, undefined,
          [{ type: 'command', command: '/Users/me/my-own-hook' }],
        )],
      },
    }, null, 2));
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    const items = s.hooks.PostToolUse[0].hooks;
    expect(items).toHaveLength(2);
    expect(items[0].command).toBe('/Users/me/my-own-hook');
    expect(items[1].command).toBe(`${canon}/hosts/claude/hooks/question-log-hook`);
  });
});

describe('legacy remove: per-item (regression)', () => {
  test('mixed SessionStart entry: user item survives in place, gstack item removed', () => {
    // REGRESSION pin: the pre-v1.67.2 legacy `remove` dropped the ENTIRE
    // entry when any item matched gstack-session-update, destroying a user's
    // co-located hook. The rewrite filters per-item; this is the only test of
    // that branch (team-mode.test.ts covers single-item entries only).
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: '/Users/me/my-own-session-hook' },
            { type: 'command', command: '/old/install/bin/gstack-session-update' },
          ],
        }],
      },
    }, null, 2));
    const r = runIso(['remove', '/old/install/bin/gstack-session-update']);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('/Users/me/my-own-session-hook');
  });
});

describe('review-army hardening (specialist findings)', () => {
  test('legacy remove preserves malformed/foreign entries it never touched', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [
          { comment: 'no hooks array at all' },
          { hooks: 'not-an-array' },
          { hooks: [] },
          { hooks: [{ type: 'command', command: '/x/bin/gstack-session-update' }] },
        ],
      },
    }, null, 2));
    runIso(['remove', '/x/bin/gstack-session-update']);
    const s = settings();
    // Only the entry we emptied is gone; the three malformed/foreign ones stay.
    expect(s.hooks.SessionStart).toHaveLength(3);
  });

  test('add-event never tags a mixed entry (old-version ratchet guard)', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: AUQ_MATCHER,
          _gstack_source: 'plan-tune-cathedral',
          hooks: [
            { type: 'command', command: '/Users/me/my-own-hook' },
            { type: 'command', command: '/dead/wt/hosts/claude/hooks/question-log-hook' },
          ],
        }],
      },
    }, null, 2));
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral',
    ]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    const e = s.hooks.PostToolUse[0];
    expect(e.hooks).toHaveLength(2);
    expect(e.hooks[0].command).toBe('/Users/me/my-own-hook');
    // A tag on a mixed entry hands old-version remove-source permission to
    // destroy the user's item — it must be gone.
    expect(e._gstack_source).toBeUndefined();
  });

  test('two dead twins of one hook in ONE entry collapse to a single item after --repoint', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: AUQ_MATCHER,
          hooks: [
            { type: 'command', command: '/dead/a/hosts/claude/hooks/question-log-hook' },
            { type: 'command', command: '/dead/b/hosts/claude/hooks/question-log-hook' },
          ],
        }],
      },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const items = settings().hooks.PostToolUse[0].hooks;
    expect(items).toHaveLength(1);   // pre-fix: two identical items → hook fires twice per event
    expect(items[0].command).toBe(`${canon}/hosts/claude/hooks/question-log-hook`);
  });

  test('a 0600 settings.json keeps its mode across mutations (API keys stay private)', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ env: { SECRET: 'x' } }, null, 2));
    fs.chmodSync(settingsFile, 0o600);
    runIso(['add-event', '--event', 'Stop', '--command', '/x/hosts/claude/hooks/timeline-stop-hook', '--source', 'gstack-timeline-stop']);
    const mode = fs.statSync(settingsFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('a canonical root containing $ is escaped in the registered command', () => {
    const trickyBase = path.join(tmpDir, 'weird$dir');
    fs.mkdirSync(trickyBase, { recursive: true });
    const canon = mkCanon(trickyBase);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [hookEntry('/dead/wt/hosts/claude/hooks/timeline-stop-hook')] },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const cmd = settings().hooks.Stop[0].hooks[0].command;
    expect(cmd.startsWith('"')).toBe(true);
    expect(cmd).toContain('\\$');   // $ neutralized — shell must not expand it at hook-fire time
    // Idempotent: the escaped command is still recognized as ours.
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r2 = runIso(['prune-stale', '--repoint', canon]);
    expect(r2.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('backups rotate: at most 10 .bak files survive repeated mutations', () => {
    for (let i = 0; i < 13; i++) {
      runIso(['add-event', '--event', 'Stop', '--command', `/x/hosts/claude/hooks/timeline-stop-hook-${i}`, '--source', 'gstack-timeline-stop']);
    }
    expect(backups().length).toBeLessThanOrEqual(10);
    // The rollback pointer still resolves to an existing backup.
    const latest = fs.readFileSync(path.join(tmpDir, 'settings.json.bak-latest'), 'utf-8').trim();
    expect(fs.existsSync(latest)).toBe(true);
  });

  test('tag-stripped verify-gate entry is table-owned: healed by --repoint, swept by --all', () => {
    // Red-team catch: verify-gate is a README-documented opt-in Stop hook.
    // Without a KNOWN_HOOKS row, a tag-stripped entry survived uninstall and
    // errored at the end of EVERY turn after the install root was deleted.
    const canon = mkCanon(tmpDir);
    const vg = path.join(canon, 'bin', 'gstack-verify-gate');
    fs.writeFileSync(vg, '#!/bin/sh\n');
    fs.chmodSync(vg, 0o755);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [hookEntry('/dead/install/bin/gstack-verify-gate')] },   // tag STRIPPED
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    let s = settings();
    expect(s.hooks.Stop[0].hooks[0].command).toBe(vg);
    expect(s.hooks.Stop[0]._gstack_source).toBe('verify-gate');
    const r = runIso(['prune-stale', '--all']);
    expect(r.stdout).toMatch(/removed 1/);
    expect(settings().hooks).toBeUndefined();
  });

  test('a foreign entry that STARTED empty survives prune-stale untouched', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    }, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r = runIso(['prune-stale', '--repoint', mkCanon(tmpDir, 'c2')]);
    expect(r.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('add-event is the quoting authority: spaced canonical path stored escaped-quoted, healer idempotent', () => {
    // Red-team catch (empirically verified pre-fix): setup registered raw
    // paths and the very next heal rewrote them — fresh installs shipped a
    // form the codebase itself considered wrong.
    const spacedBase = path.join(tmpDir, 'canon root');
    fs.mkdirSync(spacedBase, { recursive: true });
    const canon = mkCanon(spacedBase);
    runIso([
      'add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral', '--timeout', '5',
    ]);
    const stored = settings().hooks.PostToolUse[0].hooks[0].command;
    expect(stored).toBe(`"${canon}/hosts/claude/hooks/question-log-hook"`);
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r = runIso(['prune-stale', '--repoint', canon]);
    expect(r.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('rollback refuses a pointer that names a non-backup file', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ a: 1 }, null, 2));
    const evil = path.join(tmpDir, 'evil.json');
    fs.writeFileSync(evil, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/evil' }] }] } }));
    fs.writeFileSync(path.join(tmpDir, 'settings.json.bak-latest'), evil + '\n');
    const r = runIso(['rollback']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/refusing/);
    expect(settings().a).toBe(1);
  });
});

describe('ownership negatives', () => {
  test('owned basename+relpath under the WRONG matcher stays foreign (not re-pointed)', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry('/dead/wt/hosts/claude/hooks/question-log-hook', 'Bash')],
      },
    }, null, 2));
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r = runIso(['prune-stale', '--repoint', canon]);
    expect(r.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('prune-stale on an absent settings file exits 0 with removed 0', () => {
    const r = runIso(['prune-stale', '--repoint', '/nonexistent-root']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});

describe('remove-source: per-item', () => {
  test('mixed tagged entry: gstack item removed, user item survives, tag dropped', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry(
          '/x/hosts/claude/hooks/question-log-hook', AUQ_MATCHER, 'plan-tune-cathedral',
          [{ type: 'command', command: '/Users/me/my-own-hook' }],
        )],
      },
    }, null, 2));
    const r = runIso(['remove-source', '--source', 'plan-tune-cathedral']);
    expect(r.stdout).toMatch(/removed 1 hook/);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('/Users/me/my-own-hook');
    expect(s.hooks.PostToolUse[0]._gstack_source).toBeUndefined();
  });
});

describe('prune-stale', () => {
  test('prunes dead gstack items; keeps live gstack and dead non-gstack', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          hookEntry(`${canon}/hosts/claude/hooks/question-log-hook`, AUQ_MATCHER),   // live gstack
          hookEntry('/dead/wt/hosts/claude/hooks/auq-error-fallback-hook', AUQ_MATCHER), // dead gstack
          hookEntry('/dead/user/own-hook', AUQ_MATCHER),                              // dead NON-gstack
        ],
      },
    }, null, 2));
    const r = runIso(['prune-stale']);
    expect(r.stdout).toMatch(/removed 1 gstack hook entries/);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(2);
    const cmds = s.hooks.PostToolUse.map((e: any) => e.hooks[0].command);
    expect(cmds).toContain(`${canon}/hosts/claude/hooks/question-log-hook`);
    expect(cmds).toContain('/dead/user/own-hook');
  });

  test('no-op run writes no backup and leaves the file byte-identical', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { PreToolUse: [hookEntry('/Users/me/my-own-hook', 'Bash')] },
    }, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r = runIso(['prune-stale']);
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
    expect(backups()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, 'settings.json.bak-latest'))).toBe(false);
  });

  test('--repoint re-points dead AND live items, preserves bash prefix, restores tags', () => {
    const canon = mkCanon(tmpDir);
    const live = mkCanon(tmpDir, 'live-worktree');
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        Stop: [hookEntry(`${live}/hosts/claude/hooks/timeline-stop-hook`)],           // LIVE but ephemeral
        PostToolUse: [hookEntry('bash /dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER)],
      },
    }, null, 2));
    const r = runIso(['prune-stale', '--repoint', canon]);
    expect(r.stdout).toMatch(/repointed 2/);
    const s = settings();
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`${canon}/hosts/claude/hooks/timeline-stop-hook`);
    expect(s.hooks.Stop[0]._gstack_source).toBe('gstack-timeline-stop');
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`bash ${canon}/hosts/claude/hooks/question-log-hook`);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
  });

  test('--repoint collapses exact duplicates preferring the tagged twin', () => {
    const canon = mkCanon(tmpDir);
    const cmd = `${canon}/hosts/claude/hooks/question-log-hook`;
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          hookEntry('/dead/a/hosts/claude/hooks/question-log-hook', AUQ_MATCHER),
          hookEntry(cmd, AUQ_MATCHER, 'plan-tune-cathedral'),
        ],
      },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(cmd);
    expect(s.hooks.PostToolUse[0]._gstack_source).toBe('plan-tune-cathedral');
  });

  test('--repoint never ADDS entries (repair, not registration)', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile, 'utf-8');
    runIso(['prune-stale', '--repoint', canon]);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('Windows backslash path is classified as gstack-owned and pruned when dead', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry('C:\\dead\\wt\\hosts\\claude\\hooks\\question-log-hook', AUQ_MATCHER)],
      },
    }, null, 2));
    const r = runIso(['prune-stale']);
    expect(r.stdout).toMatch(/removed 1/);
    expect(settings().hooks).toBeUndefined();
  });

  test('spaced canonical root produces a quoted command that stays owned (idempotent)', () => {
    const spacedBase = path.join(tmpDir, 'My Claude');
    fs.mkdirSync(spacedBase, { recursive: true });
    const canon = mkCanon(spacedBase);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [hookEntry('/dead/wt/hosts/claude/hooks/timeline-stop-hook')] },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const s = settings();
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`"${canon}/hosts/claude/hooks/timeline-stop-hook"`);
    // Second run: the quoted command is still recognized as ours — no churn.
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const r2 = runIso(['prune-stale', '--repoint', canon]);
    expect(r2.stdout).toMatch(/removed 0 gstack hook entries \(repointed 0\)/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  test('--all removes live untagged gstack items, spares user hooks and mixed-entry user items', () => {
    const canon = mkCanon(tmpDir);
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [hookEntry(`${canon}/hosts/claude/hooks/question-log-hook`, AUQ_MATCHER)],
        Stop: [hookEntry(
          `${canon}/hosts/claude/hooks/timeline-stop-hook`, undefined, 'gstack-timeline-stop',
          [{ type: 'command', command: '/Users/me/custom-stop-hook' }],
        )],
        PreCompact: [hookEntry('/Users/me/my-own-hook')],
      },
    }, null, 2));
    const r = runIso(['prune-stale', '--all']);
    expect(r.stdout).toMatch(/removed 2/);
    const s = settings();
    expect(s.hooks.PostToolUse).toBeUndefined();
    expect(s.hooks.Stop[0].hooks).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('/Users/me/custom-stop-hook');
    expect(s.hooks.Stop[0]._gstack_source).toBeUndefined();
    expect(s.hooks.PreCompact[0].hooks[0].command).toBe('/Users/me/my-own-hook');
  });

  test('--all removes tagged single-item legacy strays (no table match)', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [hookEntry('/old/install/bin/gstack-verify-gate', undefined, 'gstack-verify-gate')] },
    }, null, 2));
    const r = runIso(['prune-stale', '--all']);
    expect(r.stdout).toMatch(/removed 1/);
    expect(settings().hooks).toBeUndefined();
  });

  test('--all and --repoint are mutually exclusive', () => {
    const r = runIso(['prune-stale', '--all', '--repoint', '/x']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  test('explicit plan_tune_hooks:no — dead plan-tune pruned, live plan-tune NOT re-pointed, Stop still re-pointed', () => {
    const canon = mkCanon(tmpDir);
    const live = mkCanon(tmpDir, 'live-worktree');
    execSync(`'${path.join(ROOT, 'bin', 'gstack-config')}' set plan_tune_hooks no`, {
      env: { ...process.env, GSTACK_STATE_ROOT: tmpDir },
      timeout: 30_000,
    });
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [
          hookEntry('/dead/wt/hosts/claude/hooks/question-log-hook', AUQ_MATCHER),        // dead plan-tune
          hookEntry(`${live}/hosts/claude/hooks/auq-error-fallback-hook`, AUQ_MATCHER),   // LIVE plan-tune
        ],
        Stop: [hookEntry('/dead/wt/hosts/claude/hooks/timeline-stop-hook')],
      },
    }, null, 2));
    runIso(['prune-stale', '--repoint', canon]);
    const s = settings();
    expect(s.hooks.PostToolUse).toHaveLength(1);
    // Live plan-tune hook left exactly where it was (no re-activation without consent).
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`${live}/hosts/claude/hooks/auq-error-fallback-hook`);
    // Stop hook is not part of the opt-out — re-pointed to canonical.
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`${canon}/hosts/claude/hooks/timeline-stop-hook`);
  });

  test('incident facsimile: the exact live-damage shape heals to canonical', () => {
    // Replays the 2026-08-17 production state: 6 PostToolUse / 3 PreToolUse /
    // 2 Stop entries; 6 dead (deleted worktrees), tags stripped on some, one
    // live-but-ephemeral Stop hook, plus a user hook that must survive.
    const canon = mkCanon(tmpDir);
    const cebu = mkCanon(tmpDir, 'cebu-v4');
    const dead = (n: string) => `/dead/biarritz-v3/hosts/claude/hooks/${n}`;
    const dead2 = (n: string) => `/dead/taipei-v2/hosts/claude/hooks/${n}`;
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [hookEntry(`${canon}/bin/gstack-session-update`)],
        PostToolUse: [
          hookEntry(`${canon}/hosts/claude/hooks/auq-error-fallback-hook`, AUQ_MATCHER),
          hookEntry(`${canon}/hosts/claude/hooks/question-log-hook`, AUQ_MATCHER),
          hookEntry(dead('question-log-hook'), AUQ_MATCHER),
          hookEntry(dead('auq-error-fallback-hook'), AUQ_MATCHER),
          hookEntry(dead2('question-log-hook'), AUQ_MATCHER, 'plan-tune-cathedral'),
          hookEntry(dead2('auq-error-fallback-hook'), AUQ_MATCHER, 'auq-error-fallback'),
        ],
        PreToolUse: [
          hookEntry(`${canon}/hosts/claude/hooks/question-preference-hook`, AUQ_MATCHER),
          hookEntry(dead('question-preference-hook'), AUQ_MATCHER),
          hookEntry(dead2('question-preference-hook'), AUQ_MATCHER, 'plan-tune-cathedral'),
        ],
        Stop: [
          hookEntry(`${cebu}/hosts/claude/hooks/timeline-stop-hook`),
          hookEntry(dead2('timeline-stop-hook'), undefined, 'gstack-timeline-stop'),
        ],
        PreCompact: [hookEntry('/Users/me/my-own-hook')],
      },
    }, null, 2));
    const r = runIso(['prune-stale', '--repoint', canon]);
    expect(r.exitCode).toBe(0);
    const s = settings();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.PreCompact[0].hooks[0].command).toBe('/Users/me/my-own-hook');
    for (const ev of ['SessionStart', 'PostToolUse', 'PreToolUse', 'Stop']) {
      for (const e of s.hooks[ev]) {
        expect(e._gstack_source).toBeDefined();
        for (const it of e.hooks) expect(it.command.startsWith(canon)).toBe(true);
      }
    }
    const postSources = s.hooks.PostToolUse.map((e: any) => e._gstack_source).sort();
    expect(postSources).toEqual(['auq-error-fallback', 'plan-tune-cathedral']);
  });
});

describe('fail-closed parse (pre-existing data-loss fix)', () => {
  const MUTATORS: string[][] = [
    ['add', '/x/bin/gstack-session-update'],
    ['remove', '/x/bin/gstack-session-update'],
    ['add-event', '--event', 'Stop', '--command', '/x', '--source', 's'],
    ['remove-source', '--source', 'plan-tune-cathedral'],
    ['prune-stale'],
  ];
  test('every mutator refuses to touch a corrupt settings.json', () => {
    for (const args of MUTATORS) {
      fs.writeFileSync(settingsFile, '{definitely not json');
      const r = runIso(args);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/refusing to mutate/);
      expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{definitely not json');
    }
  });
});

describe('mutation lock', () => {
  test('stale lock (old mtime) is taken over; mutation proceeds', () => {
    const lockDir = `${settingsFile}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'dead-process');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, old, old);
    const r = runIso(['add-event', '--event', 'Stop', '--command', '/x/hosts/claude/hooks/timeline-stop-hook', '--source', 'gstack-timeline-stop']);
    expect(r.exitCode).toBe(0);
    expect(settings().hooks.Stop).toHaveLength(1);
    expect(fs.existsSync(lockDir)).toBe(false);   // released after the mutation
  });

  test('fresh foreign lock: mutation skipped loudly (exit 5), file untouched', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile, 'utf-8');
    const lockDir = `${settingsFile}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'another-live-process');
    const r = runIso(
      ['add-event', '--event', 'Stop', '--command', '/x', '--source', 's'],
      { GSTACK_SETTINGS_LOCK_TIMEOUT_MS: '300' },
    );
    expect(r.exitCode).toBe(5);                   // loud give-up, not silent skip
    expect(r.stderr).toMatch(/could not acquire lock/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
    expect(fs.existsSync(lockDir)).toBe(true);    // foreign lock NOT stolen
  });

  test('two concurrent add-events both land (lock serializes; file stays valid JSON)', () => {
    const q = (args: string[]) =>
      [SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' ');
    const a = q(['add-event', '--event', 'PreToolUse', '--matcher', AUQ_MATCHER, '--command', '/pre-hook', '--source', 'src-a']);
    const b = q(['add-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER, '--command', '/post-hook', '--source', 'src-b']);
    execSync(`sh -c "${a} & ${b} & wait"`, {
      env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile, GSTACK_STATE_ROOT: tmpDir },
      encoding: 'utf-8',
      timeout: 20000,
    });
    const s = settings();   // throws if the file is corrupt
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(1);
  });
});

describe('gstack-settings-hook adversarial hardening', () => {
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-settings-adv-'));
    settingsFile = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runAdv(args: string[], extraEnv: Record<string, string> = {}) {
    try {
      const stdout = execSync([SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' '), {
        env: {
          ...process.env,
          GSTACK_SETTINGS_FILE: settingsFile,
          GSTACK_STATE_ROOT: tmpDir,
          ...extraEnv,
        },
        encoding: 'utf-8',
        timeout: 15000,
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (e: any) {
      return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
    }
  }

  const advSettings = (): any => JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));

  test('wrong-shape hooks value fails LOUD (exit 4), file untouched', () => {
    // bun -e swallows uncaught exceptions after a require() and exits 0
    // (verified on bun 1.3.13) -- without the gsMain umbrella this exact
    // input produced a silent exit-0 no-op that reported clean.
    const raw = JSON.stringify({ hooks: { Stop: { bogus: 'shape' } } }, null, 2) + '\n';
    fs.writeFileSync(settingsFile, raw);
    const r = runAdv(['prune-stale', '--all']);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/internal error/);
    expect(r.stderr).toMatch(/refusing to mutate/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(raw);
  });

  test('foreign hook whose basename collides with Object.prototype survives --all', () => {
    // KNOWN_HOOKS["toString"] returns an inherited member without the
    // hasOwnProperty guard -- pre-fix, this threw mid-scan and turned the
    // sweep into a silent no-op.
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/usr/local/bin/toString' }] },
          { _gstack_source: 'gstack-timeline-stop', hooks: [{ type: 'command', command: '/x/hosts/claude/hooks/timeline-stop-hook' }] },
        ],
      },
    }, null, 2) + '\n');
    const r = runAdv(['prune-stale', '--all']);
    expect(r.exitCode).toBe(0);
    const s = advSettings();
    expect(s.hooks.Stop).toHaveLength(1);   // gstack entry swept...
    expect(s.hooks.Stop[0].hooks[0].command).toBe('/usr/local/bin/toString');  // ...foreign one kept
  });

  test('GSTACK_SWEEP_EXCLUDE_SOURCES preserves verify-gate during an --all sweep', () => {
    // `setup --no-team` sweeps team hooks but must not delete the
    // user-registered verify-gate opt-in whose binary still exists.
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        Stop: [
          { _gstack_source: 'verify-gate', hooks: [{ type: 'command', command: '/x/bin/gstack-verify-gate' }] },
          { _gstack_source: 'gstack-timeline-stop', hooks: [{ type: 'command', command: '/x/hosts/claude/hooks/timeline-stop-hook' }] },
        ],
      },
    }, null, 2) + '\n');
    const r = runAdv(['prune-stale', '--all'], { GSTACK_SWEEP_EXCLUDE_SOURCES: 'verify-gate' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed 1 /);
    const s = advSettings();
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0]._gstack_source).toBe('verify-gate');
  });
});
