/**
 * Timeline Stop hook (#2553) — fail-open contract (F5).
 *
 * The preamble writes event:"started" at every skill start; the completion
 * write is end-of-workflow prose and unenforceable, so interrupted sessions
 * leaked started > completed forever. The Stop hook closes dangling entries.
 *
 * Contract under test: ALWAYS exits 0 (corrupt timeline, missing timeline,
 * garbage stdin), append-only, and the normal path appends event:"completed"
 * with outcome "unknown" + source "stop-hook" for every un-closed "started".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { canRevokeWrites } from './helpers/fs-caps';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'timeline-stop-hook');

const SLUG = 'stop-hook-test-project';

let tmpHome: string;
let projectDir: string;
let timelinePath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-hook-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-hook-proj-'));
  fs.mkdirSync(path.join(tmpHome, 'projects', SLUG), { recursive: true });
  timelinePath = path.join(tmpHome, 'projects', SLUG, 'timeline.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function runHook(stdin: string): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [HOOK], {
    input: stdin,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GSTACK_HOME: tmpHome,
      GSTACK_PROJECT_SLUG: SLUG, // deterministic slug, no git required
    },
    timeout: 15_000,
  });
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function stopPayload(): string {
  return JSON.stringify({
    session_id: 'sess-abc',
    hook_event_name: 'Stop',
    cwd: projectDir,
  });
}

function timelineEntries(): any[] {
  if (!fs.existsSync(timelinePath)) return [];
  return fs
    .readFileSync(timelinePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { __corrupt: l };
      }
    });
}

describe('timeline-stop-hook (#2553, F5 fail-open)', () => {
  test('normal path: closes dangling started entries, leaves closed pairs alone', () => {
    fs.writeFileSync(
      timelinePath,
      [
        JSON.stringify({ skill: 'review', event: 'started', branch: 'main', session: '11-1' }),
        JSON.stringify({ skill: 'ship', event: 'started', session: '22-2' }),
        JSON.stringify({ skill: 'ship', event: 'completed', session: '22-2', outcome: 'success' }),
      ].join('\n') + '\n',
    );

    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);

    const entries = timelineEntries();
    // Append-only: the three originals survive verbatim in order.
    expect(entries[0]).toMatchObject({ skill: 'review', event: 'started' });
    expect(entries[2]).toMatchObject({ skill: 'ship', event: 'completed', outcome: 'success' });

    const repairs = entries.filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      skill: 'review',
      event: 'completed',
      outcome: 'unknown',
      branch: 'main',
      session: '11-1',
    });
    expect(typeof repairs[0].ts).toBe('string');
  });

  test('idempotent: a second Stop appends nothing new', () => {
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({ skill: 'qa', event: 'started', session: '33-3' }) + '\n',
    );
    expect(runHook(stopPayload()).exitCode).toBe(0);
    const afterFirst = timelineEntries().length;
    expect(runHook(stopPayload()).exitCode).toBe(0);
    expect(timelineEntries().length).toBe(afterFirst);
  });

  test('count semantics: two runs under one key, one completed — the dangler is still repaired', () => {
    // Legacy entries carry no session field, so both runs share the same
    // skill+session key (same-second "$$-epoch" ids collide the same way).
    // With set semantics the first run's completion masked the second run's
    // dangler forever; counting closes the difference.
    fs.writeFileSync(
      timelinePath,
      [
        JSON.stringify({ skill: 'review', event: 'started' }),
        JSON.stringify({ skill: 'review', event: 'completed', outcome: 'success' }),
        JSON.stringify({ skill: 'review', event: 'started' }),
      ].join('\n') + '\n',
    );

    expect(runHook(stopPayload()).exitCode).toBe(0);
    const repairs = timelineEntries().filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ skill: 'review', event: 'completed', outcome: 'unknown' });

    // Idempotent under count semantics too: started=2, completed=2 → no-op.
    expect(runHook(stopPayload()).exitCode).toBe(0);
    expect(timelineEntries().filter((e) => e.source === 'stop-hook')).toHaveLength(1);
  });

  test('exit 0 on missing timeline (nothing written, nothing created)', () => {
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(timelinePath)).toBe(false);
  });

  test('exit 0 on a corrupt timeline; corrupt lines are skipped, valid ones still repaired', () => {
    fs.writeFileSync(
      timelinePath,
      [
        'this is not json at all {{{',
        JSON.stringify({ skill: 'qa', event: 'started', session: '44-4' }),
        '{"half": "an object"',
      ].join('\n') + '\n',
    );
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    const repairs = timelineEntries().filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0].skill).toBe('qa');
  });

  test('exit 0 on a FULLY corrupt timeline (no valid entries → no write)', () => {
    const garbage = 'garbage\n{{{\n';
    fs.writeFileSync(timelinePath, garbage);
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(timelinePath, 'utf-8')).toBe(garbage);
  });

  test('exit 0 on garbage stdin', () => {
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({ skill: 'qa', event: 'started', session: '55-5' }) + '\n',
    );
    const r = runHook('not json');
    expect(r.exitCode).toBe(0);
  });

  test('exit 0 on empty stdin', () => {
    expect(runHook('').exitCode).toBe(0);
  });

  test('tail window (P3): a recent dangling entry in a >256KB timeline is still repaired', () => {
    const lines: string[] = [];
    // An old dangling entry that falls OUTSIDE the 256KB tail window —
    // beyond repair interest by design (its session is long gone).
    lines.push(JSON.stringify({ skill: 'review', event: 'started', session: 'old-1' }));
    // >512KB of closed pairs pushes the old entry well past the window while
    // proving windowed parsing still walks real entries.
    let n = 0;
    while (lines.length * 100 < 512 * 1024) {
      lines.push(
        JSON.stringify({ skill: 'qa', event: 'started', session: `pad-${n}`, pad: '#'.repeat(40) }),
      );
      lines.push(JSON.stringify({ skill: 'qa', event: 'completed', session: `pad-${n}`, outcome: 'success' }));
      n++;
    }
    lines.push(JSON.stringify({ skill: 'ship', event: 'started', session: 'recent-9' }));
    fs.writeFileSync(timelinePath, lines.join('\n') + '\n');
    expect(fs.statSync(timelinePath).size).toBeGreaterThan(256 * 1024);

    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    const repairs = timelineEntries().filter((e) => e.source === 'stop-hook');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      skill: 'ship',
      event: 'completed',
      outcome: 'unknown',
      session: 'recent-9',
    });
  });

  test('oversized timeline is skipped, untouched, and still exits 0 (fail-open size cap)', () => {
    const line = JSON.stringify({ skill: 'qa', event: 'started', session: '66-6' }) + '\n';
    const filler = '#'.repeat(1024 * 1024);
    fs.writeFileSync(timelinePath, line + filler.repeat(11));
    const sizeBefore = fs.statSync(timelinePath).size;
    const r = runHook(stopPayload());
    expect(r.exitCode).toBe(0);
    expect(fs.statSync(timelinePath).size).toBe(sizeBefore);
  });
});

describe('timeline-stop-hook wiring', () => {
  const SETTINGS_HOOK = path.join(ROOT, 'bin', 'gstack-settings-hook');

  test('setup registers the Stop hook with its own source tag and tears it down on --no-team', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    expect(setup).toContain('--event Stop');
    expect(setup).toContain('--source gstack-timeline-stop');
    expect(setup).toContain('hosts/claude/hooks/timeline-stop-hook');
    // --no-team teardown removes it alongside the plan-tune hooks.
    const teardown = setup.slice(setup.indexOf('# Also tear down plan-tune'));
    expect(teardown).toContain('remove-source --source gstack-timeline-stop');
  });

  test('setup surfaces a settings-hook refusal instead of swallowing it', () => {
    // The hardened settings-hook refuses to rewrite a corrupt settings.json
    // (exit 1). Both setup call sites (ALREADY_INSTALLED plan-tune re-point,
    // timeline ensure-event) must stay non-fatal but PRINT the failure.
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    const warnings = setup.match(/settings hook update failed/g) || [];
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    // The old swallow patterns are gone (the --no-team remove-source teardown
    // legitimately keeps its 2>/dev/null; only the ensure-event registration
    // must surface stderr).
    expect(setup).not.toContain('_install_plan_tune_hooks >/dev/null 2>&1 || true');
    expect(setup).not.toMatch(/ensure-event[\s\S]{0,220}--source gstack-timeline-stop[\s\S]{0,40}2>\/dev\/null/);
  });

  test('setup routes the Stop hook through ensure-event, not presence-only dedup', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    // ensure-event registers when missing AND re-points a stale path in place.
    expect(setup).toMatch(/ensure-event[\s\S]{0,220}--source gstack-timeline-stop/);
    // The old guard skipped registration whenever the source tag was merely
    // PRESENT, so a stale absolute path (deleted dev worktree) was never
    // re-pointed on a setup re-run.
    expect(setup).not.toMatch(/list-sources 2>\/dev\/null \| grep -q "gstack-timeline-stop"/);
  });

  test('hook path resolution is canonical-only: global install or skip, never the worktree', () => {
    // Drive setup's _hook_command_path directly: canonical install present →
    // that path (survives deleting the worktree setup ran from). Absent →
    // non-zero and NO output — registration is skipped with a log line; the
    // running tree's path is NEVER baked into settings.json (the SOURCE
    // fallback was the phantom-hooks defect and is deliberately gone).
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    const fn = setup.match(/_hook_command_path\(\) \{[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hookpath-'));
    try {
      const canonicalRoot = path.join(fakeHome, '.claude', 'skills', 'gstack');
      const globalHook = path.join(canonicalRoot, 'hosts', 'claude', 'hooks', 'timeline-stop-hook');
      fs.mkdirSync(path.dirname(globalHook), { recursive: true });
      fs.writeFileSync(globalHook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const env = {
        ...process.env,
        HOME: fakeHome,
        SOURCE_GSTACK_DIR: '/some/dev/worktree',
        CANONICAL_GSTACK_ROOT: canonicalRoot,
      };

      const withGlobal = spawnSync(
        'bash',
        ['-c', `${fn![0]}\n_hook_command_path hosts/claude/hooks/timeline-stop-hook`],
        { env, encoding: 'utf-8', timeout: 10_000 },
      );
      expect(withGlobal.status).toBe(0);
      expect(withGlobal.stdout.trim()).toBe(globalHook);

      // No canonical install → the resolver FAILS (caller logs a visible
      // skip); it never falls back to the setup-time tree.
      fs.rmSync(globalHook);
      const withoutGlobal = spawnSync(
        'bash',
        ['-c', `${fn![0]}\n_hook_command_path hosts/claude/hooks/timeline-stop-hook`],
        { env, encoding: 'utf-8', timeout: 10_000 },
      );
      expect(withoutGlobal.status).not.toBe(0);
      expect(withoutGlobal.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('ensure-event re-points a stale absolute path and leaves exactly one registration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ensure-'));
    try {
      const settingsFile = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        hooks: {
          Stop: [{
            _gstack_source: 'gstack-timeline-stop',
            hooks: [{ type: 'command', command: '/deleted/worktree/hosts/claude/hooks/timeline-stop-hook', timeout: 5 }],
          }],
        },
      }, null, 2) + '\n');

      const r = spawnSync('bash', [
        SETTINGS_HOOK, 'ensure-event',
        '--event', 'Stop',
        '--command', HOOK,
        '--source', 'gstack-timeline-stop',
        '--timeout', '5',
      ], { env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile }, encoding: 'utf-8', timeout: 15_000 });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('re-pointed');
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      expect(s.hooks.Stop).toHaveLength(1); // replaced in place — never two
      expect(s.hooks.Stop[0].hooks[0].command).toBe(HOOK);
      expect(s.hooks.Stop[0]._gstack_source).toBe('gstack-timeline-stop');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ensure-event is a true no-op when the registration already matches (no write, no backup churn)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ensure-noop-'));
    try {
      const settingsFile = path.join(dir, 'settings.json');
      const args = [
        SETTINGS_HOOK, 'ensure-event',
        '--event', 'Stop',
        '--command', HOOK,
        '--source', 'gstack-timeline-stop',
        '--timeout', '5',
      ];
      const env = { ...process.env, GSTACK_SETTINGS_FILE: settingsFile };
      const first = spawnSync('bash', args, { env, encoding: 'utf-8', timeout: 15_000 });
      expect(first.status).toBe(0);
      const bytesAfterFirst = fs.readFileSync(settingsFile, 'utf-8');

      const second = spawnSync('bash', args, { env, encoding: 'utf-8', timeout: 15_000 });
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('unchanged');
      expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(bytesAfterFirst);
      // Re-running ./setup must not accumulate settings.json.bak.<ts> files.
      const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak'));
      expect(baks).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('corrupt settings.json: ensure-event refuses (exit 3) and never rewrites the file', () => {
    // The old catch{} folded an unparseable EXISTING settings.json into {}
    // and the atomic write replaced the user's permissions/env/other hooks
    // with just ours. Now: loud stderr error, fail-closed exit 3 (the
    // settings-hook parse-refusal code), file byte-identical.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ensure-corrupt-'));
    try {
      const settingsFile = path.join(dir, 'settings.json');
      const corrupt = '{ "permissions": { "allow": ["Bash(npm:*)"] }, INVALID';
      fs.writeFileSync(settingsFile, corrupt);

      const r = spawnSync('bash', [
        SETTINGS_HOOK, 'ensure-event',
        '--event', 'Stop',
        '--command', HOOK,
        '--source', 'gstack-timeline-stop',
        '--timeout', '5',
      ], { env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile }, encoding: 'utf-8', timeout: 15_000 });

      expect(r.status).toBe(3);
      expect(r.stderr).toContain('not valid JSON');
      // Never rewritten — the corrupt bytes (and whatever the user can still
      // salvage from them) survive verbatim.
      expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(corrupt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a matcher change updates the tagged entry in place — still exactly one registration', () => {
    // Identity key is (event, source): an existing gstack entry with a STALE
    // matcher must be updated, never joined by a second entry (the old key
    // included the matcher, so any future matcher change would duplicate).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ensure-matcher-'));
    try {
      const settingsFile = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        hooks: {
          PreToolUse: [{
            _gstack_source: 'gstack-plan-tune',
            matcher: 'OldMatcher',
            hooks: [{ type: 'command', command: '/old/path/hook', timeout: 5 }],
          }],
        },
      }, null, 2) + '\n');

      const r = spawnSync('bash', [
        SETTINGS_HOOK, 'ensure-event',
        '--event', 'PreToolUse',
        '--command', '/new/path/hook',
        '--source', 'gstack-plan-tune',
        '--matcher', 'NewMatcher',
        '--timeout', '5',
      ], { env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile }, encoding: 'utf-8', timeout: 15_000 });

      expect(r.status).toBe(0);
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      expect(s.hooks.PreToolUse).toHaveLength(1); // updated in place — never two
      expect(s.hooks.PreToolUse[0].matcher).toBe('NewMatcher');
      expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('/new/path/hook');
      expect(s.hooks.PreToolUse[0]._gstack_source).toBe('gstack-plan-tune');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed update leaves exactly one registration — never zero, never two', () => {
    // Root can write through 0o555 directories, so the failure injection
    // (read-only dir) does not bind there; the invariant is still covered by
    // the atomic tmp+rename pinned in the re-point test above.
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ensure-fail-'));
    try {
      const settingsFile = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        hooks: {
          Stop: [{
            _gstack_source: 'gstack-timeline-stop',
            hooks: [{ type: 'command', command: '/stale/path/timeline-stop-hook', timeout: 5 }],
          }],
        },
      }, null, 2) + '\n');

      fs.chmodSync(dir, 0o555); // every write path (backup, tmp, rename) fails
      const r = spawnSync('bash', [
        SETTINGS_HOOK, 'ensure-event',
        '--event', 'Stop',
        '--command', HOOK,
        '--source', 'gstack-timeline-stop',
        '--timeout', '5',
      ], { env: { ...process.env, GSTACK_SETTINGS_FILE: settingsFile }, encoding: 'utf-8', timeout: 15_000 });
      fs.chmodSync(dir, 0o755);

      expect(r.status).not.toBe(0); // the failure is loud, not swallowed
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      expect(s.hooks.Stop).toHaveLength(1); // old registration intact
      expect(s.hooks.Stop[0].hooks[0].command).toBe('/stale/path/timeline-stop-hook');
    } finally {
      try { fs.chmodSync(dir, 0o755); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('gstack-uninstall removes the Stop hook registration', () => {
    const uninstall = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-uninstall'), 'utf-8');
    expect(uninstall).toContain('remove-source --source gstack-timeline-stop');
  });

  test('the bash shim is fail-open: exits 0 even when bun is unavailable', () => {
    const r = spawnSync('bash', [HOOK], {
      input: '{}',
      encoding: 'utf-8',
      env: { HOME: tmpHome, PATH: '/usr/bin:/bin', GSTACK_HOME: tmpHome },
      timeout: 15_000,
    });
    expect(r.status).toBe(0);
  });
});
