/**
 * bin/gstack-memorable — the enable/disable/status CLI of the Memorable
 * recall bridge. Free tier; the vendor is a fake sh script that only logs
 * its argv (these verbs must never execute it).
 *
 * Isolation per test: HOME, GSTACK_HOME/STATE_ROOT/STATE_DIR (config +
 * lock), GSTACK_SETTINGS_FILE, and CLAUDE_CONFIG_DIR whose skills/gstack is
 * a symlink to this repo, so the canonical resolver finds THIS tree's hook
 * (and VERSION matches). GSTACK_MEMORABLE_BIN names the fake.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { canRevokeWrites } from './helpers/fs-caps';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-memorable');
const CONFIG = path.join(ROOT, 'bin', 'gstack-config');
const HOOK_REL = 'hosts/claude/hooks/memorable-user-prompt-hook';

let home: string;
let env: Record<string, string>;
let settings: string;
let canonical: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-memorable-bin-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'skills'), { recursive: true });
  canonical = path.join(claude, 'skills', 'gstack');
  fs.symlinkSync(ROOT, canonical);
  settings = path.join(claude, 'settings.json');
  const fake = path.join(home, 'memorable');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/calls.log"\n`, { mode: 0o755 });
  env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    GSTACK_SETTINGS_FILE: settings,
    GSTACK_HOME: path.join(home, '.gstack'),
    GSTACK_STATE_ROOT: path.join(home, '.gstack'),
    GSTACK_STATE_DIR: path.join(home, '.gstack'),
    GSTACK_MEMORABLE_BIN: fake,
  };
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function run(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [BIN, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const readSettings = (): any => JSON.parse(fs.readFileSync(settings, 'utf8'));
const gate = () => spawnSync('bash', [CONFIG, 'get', 'memorable_recall'], { env, encoding: 'utf8', timeout: 20_000 }).stdout.trim();
const setGate = (v: string) => spawnSync('bash', [CONFIG, 'set', 'memorable_recall', v], { env, encoding: 'utf8', timeout: 20_000 });
const vendorCalled = () => fs.existsSync(path.join(home, 'calls.log'));
const vendorOwn = () => `"${path.join(home, '.memorable', 'bin', 'memorable')}" hook user-prompt`;
const writeSettings = (obj: unknown) => fs.writeFileSync(settings, JSON.stringify(obj, null, 2));
const commands = () => readSettings().hooks.UserPromptSubmit.flatMap((e: any) => e.hooks.map((h: any) => h.command));

describe('enable', () => {
  test('registers the CANONICAL hook path with timeout 5, sets the gate on, never runs the vendor, explains the hand-off', () => {
    const r = run(['enable']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const entries = readSettings().hooks.UserPromptSubmit;
    expect(entries).toHaveLength(1);
    expect(entries[0]._gstack_source).toBe('gstack-memorable');
    expect(entries[0].hooks).toEqual([{ type: 'command', command: `${canonical}/${HOOK_REL}`, timeout: 5 }]);
    expect(entries[0].hooks[0].command.startsWith(env.CLAUDE_CONFIG_DIR)).toBe(true); // canonical, not ROOT
    expect(gate()).toBe('on');
    expect(vendorCalled()).toBe(false);
    for (const s of ['registered', 'memorable_recall=on', 'gstack-egress list --sink memorable-recall', 'gstack-memorable disable',
      'within a few seconds', 'gstack-memorable status', 'memorable enable', 'memorable forget', 'HIGH-tier'] ) {
      expect(r.stdout).toContain(s);
    }
  });

  test('twice: unchanged, one entry; over a stale worktree path: re-pointed', () => {
    expect(run(['enable']).stdout).toContain('registered');
    const again = run(['enable']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('unchanged');
    expect(readSettings().hooks.UserPromptSubmit).toHaveLength(1);
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `/dead/worktree/${HOOK_REL}`, timeout: 5 }] }] } });
    const rp = run(['enable']);
    expect(rp.status).toBe(0);
    expect(rp.stdout).toContain('re-pointed');
    expect(commands()).toEqual([`${canonical}/${HOOK_REL}`]);
  });

  test('refuses without a stable install (no canonical tree), writes nothing', () => {
    fs.rmSync(canonical);
    const r = run(['enable']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run ./setup');
    expect(fs.existsSync(settings)).toBe(false);
    expect(gate()).toBe('off');
  });

  test('refuses a mixed-version stable install (old hook without the .ts twin, different VERSION)', () => {
    fs.rmSync(canonical);
    fs.mkdirSync(path.join(canonical, 'hosts', 'claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(canonical, 'bin'), { recursive: true });
    for (const rel of ['bin/gstack-session-update', HOOK_REL]) fs.writeFileSync(path.join(canonical, rel), '#!/bin/sh\n', { mode: 0o755 });
    fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), path.join(canonical, 'bin', 'gstack-settings-hook'));
    fs.chmodSync(path.join(canonical, 'bin', 'gstack-settings-hook'), 0o755);
    fs.writeFileSync(path.join(canonical, 'VERSION'), '0.0.0.0\n');
    const r = run(['enable']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/predates this bridge|is version '0.0.0.0'/);
    expect(fs.existsSync(settings)).toBe(false);
    expect(gate()).toBe('off');
  });

  test('refuses when the vendor CLI is absent; never installs anything', () => {
    const r = run(['enable'], { GSTACK_MEMORABLE_BIN: path.join(home, 'nope') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('npm i -g memorable-cli');
    expect(fs.existsSync(settings)).toBe(false);
    expect(gate()).toBe('off');
  });

  test("refuses when Memorable registered the hook itself (the real 0.5.18 installer string); settings and gate untouched", () => {
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: vendorOwn() }] }] } });
    const before = fs.readFileSync(settings, 'utf8');
    const r = run(['enable']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already registers this hook itself');
    expect(r.stderr).toContain(settings);
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
    expect(gate()).toBe('off');
    expect(vendorCalled()).toBe(false);
  });

  test('a foreign UserPromptSubmit hook is not mistaken for the vendor: enable proceeds beside it', () => {
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/foreign/hook' }] }] } });
    expect(run(['enable']).status).toBe(0);
    expect(commands()).toEqual(['/foreign/hook', `${canonical}/${HOOK_REL}`]);
  });

  test('corrupt settings.json: exit 3, gate stays off; unexpected shape: exit 4', () => {
    fs.writeFileSync(settings, '{not json');
    let r = run(['enable']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('not valid JSON');
    expect(gate()).toBe('off');
    writeSettings({ hooks: { UserPromptSubmit: {} } });
    r = run(['enable']);
    expect(r.status).toBe(4);
    expect(gate()).toBe('off');
  });

  test('refuses on Windows (deferred whole, D21) without touching anything', () => {
    const r = run(['enable'], { GSTACK_MEMORABLE_TEST_UNAME: 'MINGW64_NT-10.0' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Windows is not supported');
    expect(fs.existsSync(settings)).toBe(false);
  });

  test('when recording consent fails, prior state is restored: a fresh registration is removed, a pre-existing one kept', () => {
    // make config.yaml unwritable AFTER the gate was read: point the state dir at a read-only file
    const roState = path.join(home, 'ro-state');
    fs.mkdirSync(roState);
    fs.writeFileSync(path.join(roState, 'config.yaml'), 'telemetry: off\n', { mode: 0o444 });
    fs.mkdirSync(path.join(roState, 'locks')); // the bridge lock must still be takeable: only the consent write may fail
    fs.chmodSync(roState, 0o555);
    const ro = { GSTACK_HOME: roState, GSTACK_STATE_ROOT: roState, GSTACK_STATE_DIR: roState };
    const r = run(['enable'], ro);
    fs.chmodSync(roState, 0o755);
    if (!canRevokeWrites()) { expect(r.status).toBe(0); return; } // modes not enforced here: the write succeeds
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not record consent');
    expect(fs.existsSync(settings) ? (readSettings().hooks ?? {}).UserPromptSubmit : undefined).toBeUndefined(); // fresh registration rolled back
  });
});

describe('disable', () => {
  test('removes a TAG-STRIPPED registration by identity, sets the gate off, keeps the foreign sibling, exit 0', () => {
    setGate('on');
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [
      { type: 'command', command: '/foreign/hook' },
      { type: 'command', command: `${canonical}/${HOOK_REL}`, timeout: 5 },
    ] }] } });
    const r = run(['disable']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('consent: memorable_recall=off');
    expect(r.stdout).toContain('hook: removed');
    expect(r.stdout).toContain('In-flight prompts');
    expect(commands()).toEqual(['/foreign/hook']);
    expect(gate()).toBe('off');
    expect(vendorCalled()).toBe(false);
  });

  test('vendor CLI absent: still exit 0, gate off, says there is nothing of the vendor to revoke', () => {
    run(['enable']);
    const r = run(['disable'], { GSTACK_MEMORABLE_BIN: path.join(home, 'nope') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing of the vendor');
    expect(gate()).toBe('off');
    expect(readSettings().hooks).toBeUndefined();
  });

  test('never runs memorable disable; tells the user the vendor consent is separate', () => {
    run(['enable']);
    const r = run(['disable']);
    expect(r.stdout).toContain('memorable disable | memorable forget');
    expect(vendorCalled()).toBe(false);
  });

  test('corrupt settings.json: the gate goes off FIRST, the failure is reported, exit non-zero', () => {
    setGate('on');
    fs.writeFileSync(settings, '{not json');
    const r = run(['disable']);
    expect(r.status).toBe(3);
    expect(gate()).toBe('off');
    expect(r.stdout).toContain('consent: memorable_recall=off');
    expect(r.stderr).toContain('not valid JSON');
  });

  test('nothing registered: idempotent, exit 0', () => {
    const r = run(['disable']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('hook: removed');
  });
});

describe('status (read-only)', () => {
  test('fresh: vendor found, gate off, not registered; writes nothing, never runs the vendor', () => {
    const r = run(['status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Memorable CLI: available');
    expect(r.stdout).toContain('memorable_recall: off');
    expect(r.stdout).toContain('not registered');
    expect(fs.existsSync(settings)).toBe(false);
    expect(vendorCalled()).toBe(false);
  });

  test('tag-stripped gstack registration, plain and bash-prefixed quoted: "registered by gstack"', () => {
    setGate('on');
    for (const cmd of [`${canonical}/${HOOK_REL}`, `bash "${canonical}/${HOOK_REL}"`]) {
      writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd }] }] } });
      const r = run(['status']);
      expect(r.stdout).toContain('registered by gstack');
      expect(r.stdout).not.toContain('not registered');
      expect(r.stdout).not.toContain('mismatch');
    }
  });

  test("vendor-own registration: 'registered by Memorable itself'", () => {
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: vendorOwn() }] }] } });
    const r = run(['status']);
    expect(r.stdout).toContain('registered by Memorable itself');
    expect(r.stdout).toContain('would refuse');
  });

  test('mismatch lines: gate on with no hook; hook present with gate off; both registered', () => {
    setGate('on');
    expect(run(['status']).stdout).toContain('mismatch: gate on, no hook');
    setGate('off');
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${canonical}/${HOOK_REL}` }] }, { hooks: [{ type: 'command', command: vendorOwn() }] }] } });
    const r = run(['status']);
    expect(r.stdout).toContain('registered by BOTH');
    expect(r.stdout).toContain('hook is inert');
  });

  test('unparseable settings and bun missing are named, exit 0', () => {
    fs.writeFileSync(settings, '{bad');
    expect(run(['status']).stdout).toContain('unknown (');
    const r = run(['status'], { PATH: '/usr/bin:/bin' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('bun: missing');
  });

  test('tails recent hook errors and counts receipts for the sink', () => {
    fs.mkdirSync(env.GSTACK_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.GSTACK_HOME, 'hook-errors.log'), '2026-09-08T00:00:00Z memorable-user-prompt-hook: vendor timeout\n');
    const r = run(['status']);
    expect(r.stdout).toContain('recent hook errors');
    expect(r.stdout).toContain('vendor timeout');
    expect(r.stdout).toMatch(/receipts: \d+ for sink memorable-recall/);
  });

  test('vendor resolution precedence: GSTACK_MEMORABLE_BIN > MEMORABLE_BIN > ~/.memorable/bin/memorable > PATH; an unresolvable override is an error', () => {
    const mk = (p: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };
    const a = mk(path.join(home, 'a', 'memorable'));
    const b = mk(path.join(home, 'b', 'memorable'));
    const pinned = mk(path.join(home, '.memorable', 'bin', 'memorable'));
    const onPath = mk(path.join(home, 'pathdir', 'memorable'));
    const base = { GSTACK_MEMORABLE_BIN: '', MEMORABLE_BIN: '', PATH: `${path.join(home, 'pathdir')}:${env.PATH}` };
    expect(run(['status'], { ...base, GSTACK_MEMORABLE_BIN: a, MEMORABLE_BIN: b }).stdout).toContain(`available (${a})`);
    expect(run(['status'], { ...base, MEMORABLE_BIN: b }).stdout).toContain(`available (${b})`);
    expect(run(['status'], base).stdout).toContain(`available (${pinned})`);
    fs.rmSync(pinned);
    expect(run(['status'], base).stdout).toContain(`available (${onPath})`);
    expect(run(['status'], { ...base, GSTACK_MEMORABLE_BIN: path.join(home, 'missing') }).stdout).toContain('not found');
  });
});

describe('enable/disable failure paths (coverage audit)', () => {

  function mixedCanonical(version: string, settingsHookBody?: string) {
    fs.rmSync(canonical);
    fs.mkdirSync(path.join(canonical, 'hosts', 'claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(canonical, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(canonical, 'bin', 'gstack-session-update'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(canonical, HOOK_REL), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(canonical, `${HOOK_REL}.ts`), '// twin\n');
    if (settingsHookBody) fs.writeFileSync(path.join(canonical, 'bin', 'gstack-settings-hook'), settingsHookBody, { mode: 0o755 });
    else { fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), path.join(canonical, 'bin', 'gstack-settings-hook')); fs.chmodSync(path.join(canonical, 'bin', 'gstack-settings-hook'), 0o755); }
    fs.writeFileSync(path.join(canonical, 'VERSION'), version);
  }

  test('enable refuses on a VERSION mismatch alone (hook and twin present)', () => {
    mixedCanonical('0.0.0.0\n');
    const r = run(['enable']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is version '0.0.0.0'");
    expect(fs.existsSync(settings)).toBe(false);
  });

  test('enable refuses when the stable hook manager does not know list-items', () => {
    mixedCanonical(fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8'), '#!/bin/sh\necho "Unknown action: $1" >&2\nexit 1\n');
    const r = run(['enable']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not know list-items');
    expect(fs.existsSync(settings)).toBe(false);
  });

  test('enable refuses when BOTH gstack and the vendor are registered; disable then removes only gstack\'s entry', () => {
    writeSettings({ hooks: { UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `${canonical}/${HOOK_REL}`, timeout: 5 }] },
      { hooks: [{ type: 'command', command: vendorOwn() }] },
    ] } });
    const before = fs.readFileSync(settings, 'utf8');
    const r = run(['enable']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already registers this hook itself');
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
    const d = run(['disable']);
    expect(d.status).toBe(0);
    expect(commands()).toEqual([vendorOwn()]);
  });

  test('enable passes the hook manager\'s lock give-up (exit 5) through and leaves the gate untouched', () => {
    fs.mkdirSync(`${settings}.lock`, { recursive: true });
    fs.writeFileSync(path.join(`${settings}.lock`, 'owner'), 'another-live-process');
    // the hook manager's give-up defaults to 10 s; its test-only override keeps this fast
    const r = run(['enable'], { GSTACK_SETTINGS_LOCK_TIMEOUT_MS: '500' });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('settings hook update failed');
    expect(gate()).toBe('off');
    expect(fs.existsSync(settings)).toBe(false);
  }, 30_000);

  test('disable surfaces a hook-manager lock give-up as exit 5 after flipping the gate off', () => {
    setGate('on');
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${canonical}/${HOOK_REL}` }] }] } });
    fs.mkdirSync(`${settings}.lock`, { recursive: true });
    fs.writeFileSync(path.join(`${settings}.lock`, 'owner'), 'another-live-process');
    const r = run(['disable'], { GSTACK_SETTINGS_LOCK_TIMEOUT_MS: '500' });
    expect(r.status).toBe(5);
    expect(gate()).toBe('off');
    expect(r.stdout).toContain('consent: memorable_recall=off');
    expect(r.stderr).toContain('survived');
  }, 30_000);

  test('a FRESH bridge lock held by another process makes enable exit 5 after the wait, lock left in place', () => {
    const lock = path.join(env.GSTACK_HOME, 'locks', 'memorable-bridge.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'ts'), String(Math.floor(Date.now() / 1000)));
    fs.writeFileSync(path.join(lock, 'owner'), '999999');
    const t0 = Date.now();
    const r = run(['enable']);
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('another gstack-memorable is running');
    expect(Date.now() - t0).toBeGreaterThan(4000);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(settings)).toBe(false);
  }, 30_000);

  test('consent-write failure with a PRE-EXISTING registration keeps the registration and restores the prior gate', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    // state dir: gate already 'on' from an earlier enable, then made read-only
    setGate('on');
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${canonical}/${HOOK_REL}`, timeout: 5 }] }] } });
    fs.mkdirSync(path.join(env.GSTACK_HOME, 'locks'), { recursive: true }); // lock stays takeable; only the consent write fails
    fs.chmodSync(path.join(env.GSTACK_HOME, 'config.yaml'), 0o444);
    fs.chmodSync(env.GSTACK_HOME, 0o555);
    const r = run(['enable']);
    fs.chmodSync(env.GSTACK_HOME, 0o755);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not record consent');
    expect(commands()).toEqual([`${canonical}/${HOOK_REL}`]);   // pre-existing registration kept
    expect(gate()).toBe('on');                                    // prior value, not an assumed off
  });

  test('disable reports a failed consent write, still removes the hook, exits 1', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    setGate('on');
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${canonical}/${HOOK_REL}` }] }] } });
    fs.mkdirSync(path.join(env.GSTACK_HOME, 'locks'), { recursive: true }); // lock stays takeable; only the consent write fails
    fs.chmodSync(path.join(env.GSTACK_HOME, 'config.yaml'), 0o444);
    fs.chmodSync(env.GSTACK_HOME, 0o555);
    const r = run(['disable']);
    fs.chmodSync(env.GSTACK_HOME, 0o755);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('consent: could not set');
    expect(r.stdout).toContain('hook: removed');
  });

  test('usage: no verb exits 1 with usage on stderr; -h exits 0 with usage on stdout', () => {
    const none = run([]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('Usage: gstack-memorable');
    const help = run(['-h']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: gstack-memorable');
  });

  test('status names the Windows deferral and counts real receipts for the sink', () => {
    expect(run(['status'], { GSTACK_MEMORABLE_TEST_UNAME: 'MINGW64_NT-10.0' }).stdout).toContain('platform: Windows is not supported');
    for (let i = 0; i < 2; i++) {
      const w = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-egress-receipt'), 'write', '--sink', 'memorable-recall', '--host', 'local:/x/memorable', '--class', 'c', '--no-payload', '--consent', 'memorable_recall=on'], { env, encoding: 'utf8', timeout: 20_000 });
      expect(w.status).toBe(0);
    }
    const st = run(['status']).stdout;
    expect(st).toContain('receipts: 2 for sink memorable-recall');
    expect(st).toMatch(/ledger: .*egress\.jsonl \(\d+ KiB; this sink appends two lines per prompt\)/);
  });
});

describe('lifecycle lock and static pins', () => {
  test('two concurrent enables serialise: one entry, gate on, both exit 0', async () => {
    const kids = [0, 1].map(() => Bun.spawn(['bash', BIN, 'enable'], { env, stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(kids.map((k) => k.exited));
    expect(codes).toEqual([0, 0]);
    expect(readSettings().hooks.UserPromptSubmit).toHaveLength(1);
    expect(gate()).toBe('on');
    expect(fs.existsSync(path.join(env.GSTACK_HOME, 'locks', 'memorable-bridge.lock'))).toBe(false);
  }, 30_000);

  test('a stale lock (directory older than 30 s) is taken over', () => {
    const lock = path.join(env.GSTACK_HOME, 'locks', 'memorable-bridge.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner'), '999999');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old); // staleness comes from the directory mtime that mkdir set
    expect(run(['enable']).status).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test('a stale lock that cannot be reclaimed (locks dir not writable) still reaches the 5 s give-up instead of spinning', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here
    const locksDir = path.join(env.GSTACK_HOME, 'locks');
    const lock = path.join(locksDir, 'memorable-bridge.lock');
    fs.mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    fs.chmodSync(locksDir, 0o555); // mv/rmdir of the stale lock now fails
    const t0 = Date.now();
    let r;
    try { r = run(['disable']); } finally { fs.chmodSync(locksDir, 0o755); }
    const wall = Date.now() - t0;
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('another gstack-memorable is running');
    expect(wall).toBeGreaterThan(4000);
    expect(wall).toBeLessThan(12_000);
  }, 30_000);

  test('a fresh lock with no bookkeeping yet (the mkdir-to-owner gap) is waited on, never reclaimed', () => {
    const lock = path.join(env.GSTACK_HOME, 'locks', 'memorable-bridge.lock');
    fs.mkdirSync(lock, { recursive: true }); // no owner, no ts: a holder that just won mkdir
    const t0 = Date.now();
    const r = run(['disable']);
    expect(r.status).toBe(5);
    expect(Date.now() - t0).toBeGreaterThan(4000);
    expect(fs.existsSync(lock)).toBe(true);
  }, 30_000);

  test('source pins: canonical-only command, Windows refusal, no vendor invocation, explicit-status style', () => {
    const src = fs.readFileSync(BIN, 'utf8');
    expect(src).toContain('IS_WINDOWS');
    expect(src).not.toMatch(/--command "\$ROOT_DIR/);
    expect(src).toContain('CANONICAL_GSTACK_ROOT');
    expect(src).not.toMatch(/"\$vendor" (enable|disable|status)/);
    expect(src).toContain('set -uo pipefail');
    expect(src).not.toContain('set -euo');
    expect(src).toContain('BASH_COMPAT=50');
  });
});
