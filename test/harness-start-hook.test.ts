/**
 * The gstack-start hook (GST-718): opt-in OpenClaw and Hermes plugins that put gstack's start note on every user
 * turn. Harness CLIs are fake /bin/sh scripts on PATH that record their argv and environment and keep the
 * plugin state in the profile, so these cases run no harness and spend nothing.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TARGETS, readLedger, register, status, unregister, type RegisterOptions } from '../lib/harness-register';
import { HOOK_ID, START_NOTE, START_NOTE_MAX, hookChoice, hookFiles } from '../lib/harness-start-hook';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, registryRows, runSetup } from './helpers/install-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const temps: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-test-'))); temps.push(d); return d; };
afterEach(() => { cleanupFixtures(); for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
afterAll(cleanupSeed);

const FAKE_OPENCLAW = String.raw`#!/bin/sh
d="$OPENCLAW_STATE_DIR"; c="$d/fake-config"
printf '%s|secret=%s|home=%s|cfg=%s\n' "$*" "$ANTHROPIC_API_KEY" "$HOME" "$OPENCLAW_CONFIG_PATH" >> "$d/fake-calls"
[ -f "$d/fake-fail" ] && { echo "config write refused" >&2; exit 3; }
touch "$c"
acc=false; grep -q '^plugins.entries.gstack-start.hooks.allowConversationAccess=true$' "$c" && acc=true
en=$(grep '^plugins.entries.gstack-start.enabled=' "$c" | tail -1 | cut -d= -f2); enj=null; [ -n "$en" ] && enj=$en
case "$1 $2" in
  "config set") echo "$3=$4" >> "$c" ;;
  "config unset") grep -v "^$3" "$c" > "$c.t"; mv "$c.t" "$c" ;;
  "config get") printf '{"allow":%s,"entries":{"gstack-start":{"enabled":%s,"hooks":{"allowConversationAccess":%s}}}}\n' "$(cat "$d/fake-allow" 2>/dev/null || echo null)" "$enj" "$acc" ;;
  "plugins inspect")
    hooks=""; [ -d "$d/extensions/gstack-start" ] && [ "$acc" = true ] && [ "$en" != false ] && hooks='{"name":"before_prompt_build"}'
    printf '{"plugin":{"status":"loaded","enabled":%s},"typedHooks":[%s]}\n' "$([ "$en" = false ] && echo false || echo true)" "$hooks" ;;
esac
`;
const FAKE_HERMES = String.raw`#!/bin/sh
d="$HERMES_HOME"
printf '%s|secret=%s|home=%s\n' "$*" "$ANTHROPIC_API_KEY" "$HOME" >> "$d/fake-calls"
case "$1 $2" in
  "plugins enable") echo enabled > "$d/fake-state" ;;
  "plugins disable") echo disabled > "$d/fake-state" ;;
  "plugins remove") rm -rf "$d/plugins/$3" "$d/fake-state" ;;
  "plugins list") if [ -d "$d/plugins/gstack-start" ]; then printf '[{"name":"gstack-start","status":"%s"}]\n' "$(cat "$d/fake-state" 2>/dev/null || echo 'not enabled')"; else echo '[]'; fi ;;
esac
`;

/** A temp home, state root and profile, with fake openclaw and hermes CLIs first on PATH. */
function rig(target: 'openclaw' | 'hermes', extra: { noCli?: boolean; env?: Record<string, string> } = {}) {
  const d = tmp();
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'openclaw'), FAKE_OPENCLAW, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hermes'), FAKE_HERMES, { mode: 0o755 });
  const profile = path.join(d, target === 'openclaw' ? 'oc' : 'he');
  fs.mkdirSync(profile, { recursive: true });
  const env = { PATH: (extra.noCli ? '' : bin + path.delimiter) + '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sekret', OPENCLAW_CONFIG_PATH: '/elsewhere/openclaw.json', [target === 'openclaw' ? 'OPENCLAW_STATE_DIR' : 'HERMES_HOME']: profile, ...extra.env };
  const o = (more: Partial<RegisterOptions> = {}): RegisterOptions => ({ target: TARGETS[target], checkout: ROOT, stateRoot: path.join(d, 'state'), env, home: path.join(d, 'home'), version: VERSION, ...more });
  const root = path.join(profile, target === 'openclaw' ? 'extensions' : 'plugins', HOOK_ID);
  const calls = () => fs.existsSync(path.join(profile, 'fake-calls')) ? fs.readFileSync(path.join(profile, 'fake-calls'), 'utf8').trim().split('\n') : [];
  return { d, bin, profile, env, o, root, calls };
}

describe('start hook: the note and the plugin files', () => {
  test('the note fits its budget and names the helper every rendered preamble runs', () => {
    expect(START_NOTE.length).toBeLessThanOrEqual(START_NOTE_MAX);
    expect(START_NOTE).toContain('gstack-skill-start');
    const review = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf8');
    expect(review).toContain('## Preamble');
    expect(review).toMatch(/bin\/gstack-skill-start --skill "review"/);
  });

  test('plugin code is fixed text: no install path in it, and it reads note.txt from its own folder', () => {
    for (const t of ['openclaw', 'hermes'] as const) {
      const a = hookFiles(t, '/one/place/' + HOOK_ID); const b = hookFiles(t, '/an\'other "place"/' + HOOK_ID);
      expect([...a.values()].map(String)).toEqual([...b.values()].map(String));
      for (const [p, bytes] of a) if (!p.endsWith('note.txt')) expect(String(bytes)).not.toContain('/one/place');
      expect(String(a.get('/one/place/' + HOOK_ID + '/note.txt'))).toBe(START_NOTE + '\n');
    }
  });

  test('the OpenClaw plugin returns the note as prependContext, and nothing when note.txt is gone', async () => {
    const d = tmp();
    for (const [p, b] of hookFiles('openclaw', d)) fs.writeFileSync(p, b);
    const load = async () => {
      let handler: (() => unknown) | undefined;
      const mod = await import(path.join(d, 'index.js') + '?' + Math.random());
      mod.default.register({ on: (name: string, fn: () => unknown) => { expect(name).toBe('before_prompt_build'); handler = fn; } });
      return handler!();
    };
    expect(await load()).toEqual({ prependContext: START_NOTE });
    fs.rmSync(path.join(d, 'note.txt'));
    expect(await load()).toBeUndefined();
  });

  test('the Hermes plugin registers pre_llm_call and returns the note as context, and nothing when note.txt is gone', () => {
    const d = tmp();
    const pkg = path.join(d, 'gstack_start');
    fs.mkdirSync(pkg);
    for (const [p, b] of hookFiles('hermes', pkg)) fs.writeFileSync(p, b);
    const probe = 'import sys, json\nsys.path.insert(0, sys.argv[1])\nimport gstack_start as m\nseen = []\nclass Ctx:\n    def register_hook(self, name, fn): seen.append((name, fn))\nm.register(Ctx())\nprint(json.dumps([seen[0][0], seen[0][1](session_id="s", user_message="hi")]))\n';
    const run = () => spawnSync('python3', ['-B', '-c', probe, d], { encoding: 'utf8', timeout: 30_000 });
    let r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['pre_llm_call', { context: START_NOTE }]);
    fs.rmSync(path.join(pkg, 'note.txt'));
    r = run();
    expect(JSON.parse(r.stdout)).toEqual(['pre_llm_call', null]);
  });
});

describe('start hook: who decides', () => {
  test('flag, then GSTACK_HARNESS_START_HOOK, then gstack-config harness_start_hook, then the ledger', () => {
    const d = tmp();
    const state = path.join(d, 'state');
    fs.mkdirSync(state);
    expect(hookChoice(undefined, {}, state, undefined)).toEqual({ on: false, source: 'ledger' });
    expect(hookChoice(undefined, {}, state, 'on')).toEqual({ on: true, source: 'ledger' });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'harness_start_hook: off\n');
    expect(hookChoice(undefined, {}, state, 'on')).toEqual({ on: false, source: 'config' });
    expect(hookChoice(undefined, { GSTACK_HARNESS_START_HOOK: '1' }, state, undefined)).toEqual({ on: true, source: 'env' });
    expect(hookChoice(false, { GSTACK_HARNESS_START_HOOK: 'on' }, state, 'on')).toEqual({ on: false, source: 'flag' });
    expect(hookChoice(undefined, { GSTACK_HARNESS_START_HOOK: 'maybe' }, state, undefined)).toEqual({ invalid: 'GSTACK_HARNESS_START_HOOK="maybe"' });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'harness_start_hook: sometimes\n');
    expect(hookChoice(undefined, {}, state, undefined)).toEqual({ invalid: 'gstack-config harness_start_hook="sometimes"' });
  });

  test('gstack-config takes harness_start_hook on or off and refuses anything else', () => {
    const d = tmp();
    const cfg = (...args: string[]) => spawnSync(path.join(ROOT, 'bin', 'gstack-config'), args, { env: { PATH: process.env.PATH, HOME: path.join(d, 'home'), GSTACK_STATE_ROOT: path.join(d, 'state') }, encoding: 'utf8', timeout: 30_000 });
    expect(cfg('set', 'harness_start_hook', 'on').status).toBe(0);
    expect(cfg('get', 'harness_start_hook').stdout.trim()).toBe('on');
    const bad = cfg('set', 'harness_start_hook', 'yes');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("harness_start_hook 'yes' not recognized");
    expect(cfg('get', 'harness_start_hook').stdout.trim()).toBe('on');
  });

  test('an invalid choice and a hook for a target or folder without one stop before anything is written', () => {
    const r = rig('openclaw', { env: { GSTACK_HARNESS_START_HOOK: 'maybe' } });
    expect(() => register(r.o())).toThrow(expect.objectContaining({ code: 'HARNESS_HOOK_CHOICE_INVALID' }));
    const s = rig('openclaw');
    expect(() => register(s.o({ skillsDir: path.join(s.d, 'custom', 'skills'), startHook: true }))).toThrow(expect.objectContaining({ code: 'HARNESS_HOOK_UNSUPPORTED' }));
    expect(() => register({ ...s.o({ startHook: true }), target: TARGETS.dots, skillsDir: path.join(s.d, 'dots') })).toThrow(expect.objectContaining({ code: 'HARNESS_HOOK_UNSUPPORTED' }));
    for (const x of [r, s]) { expect(fs.existsSync(path.join(x.profile, 'skills'))).toBe(false); expect(x.calls()).toEqual([]); }
    expect(fs.existsSync(path.join(s.d, 'custom'))).toBe(false);
  });

  test('a plugin folder gstack did not write, or a symlink on the way to it, stops the hook untouched', () => {
    const r = rig('openclaw');
    fs.mkdirSync(r.root, { recursive: true });
    fs.writeFileSync(path.join(r.root, 'index.js'), 'mine');
    expect(() => register(r.o({ startHook: true }))).toThrow(expect.objectContaining({ code: 'HARNESS_HOOK_OWNED_ELSEWHERE' }));
    expect(fs.readFileSync(path.join(r.root, 'index.js'), 'utf8')).toBe('mine');
    const s = rig('hermes');
    fs.mkdirSync(path.join(s.d, 'elsewhere'));
    fs.symlinkSync(path.join(s.d, 'elsewhere'), path.join(s.profile, 'plugins'));
    expect(() => register(s.o({ startHook: true }))).toThrow(expect.objectContaining({ code: 'HARNESS_UNSAFE_DESTINATION' }));
    expect(fs.readdirSync(path.join(s.d, 'elsewhere'))).toEqual([]);
    expect(r.calls().concat(s.calls())).toEqual([]);
  });
});

describe('start hook: OpenClaw lifecycle (fake CLI)', () => {
  test('default registration adds no plugin and runs no harness command', () => {
    const r = rig('openclaw');
    const res = register(r.o());
    expect(res.hook).toEqual({ state: 'off' });
    expect(fs.existsSync(path.join(r.profile, 'extensions'))).toBe(false);
    expect(r.calls()).toEqual([]);
    expect(readLedger(res.ledger)!.files.every(f => f.path.startsWith(path.join(r.profile, 'skills') + path.sep))).toBe(true);
  }, 120_000);

  test('on, refreshed, disabled by the user, then off: activation runs once, a user disable sticks, opt-out cleans up', () => {
    const r = rig('openclaw');
    const on = register(r.o({ startHook: true }));
    expect(on.hook).toMatchObject({ state: 'active', required: true, profile: r.profile, root: r.root });
    expect(fs.readdirSync(r.root).sort()).toEqual(['index.js', 'note.txt', 'openclaw.plugin.json', 'package.json']);
    const meta = readLedger(on.ledger)!.meta;
    expect([meta.start_hook, meta.hook_profile, meta.hook_root]).toEqual(['on', r.profile, r.root]);
    const argv = r.calls().map(l => l.split('|')[0]);
    expect(argv).toEqual([
      'config set plugins.entries.gstack-start.hooks.allowConversationAccess true',
      'config set plugins.entries.gstack-start.enabled true',
      'config get plugins --json',
      'plugins inspect gstack-start --runtime --json',
    ]);
    for (const l of r.calls()) expect(l).toContain('|secret=|home=' + path.join(r.d, 'home') + '|cfg=');

    const again = register(r.o());
    expect(again.status).toBe('unchanged');
    expect(again.hook?.state).toBe('unchecked');
    expect(r.calls()).toHaveLength(4);

    fs.appendFileSync(path.join(r.profile, 'fake-config'), 'plugins.entries.gstack-start.enabled=false\n');
    register(r.o());
    expect(r.calls().filter(l => l.startsWith('config set'))).toHaveLength(2);
    expect(status(r.o().stateRoot, VERSION, r.env).find(s => s.target === 'openclaw')?.hook?.state).toBe('disabled');

    const off = register(r.o({ startHook: false }));
    expect(off.hook?.state).toBe('off');
    expect(r.calls().some(l => l.startsWith('config unset plugins.entries.gstack-start|'))).toBe(true);
    expect(fs.existsSync(path.join(r.profile, 'extensions'))).toBe(false);
    const after = readLedger(off.ledger)!.meta;
    expect(after.start_hook).toBe('off');
    expect(after.hook_root).toBeUndefined();
  }, 300_000);

  test('a failed or blocked activation reports written with the fix; the CLI exits 4 after registering the skills', () => {
    const r = rig('openclaw');
    fs.writeFileSync(path.join(r.profile, 'fake-allow'), '["anthropic"]');
    const res = register(r.o({ startHook: true }));
    expect(res.hook).toMatchObject({ state: 'written', required: true, detail: 'plugins.allow is set and does not list gstack-start' });
    expect(res.hook?.fix).toContain('openclaw config set plugins.allow \'["anthropic","gstack-start"]\'');

    const s = rig('openclaw');
    fs.writeFileSync(path.join(s.profile, 'fake-fail'), '');
    const cli = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin', 'gstack-harness'), 'register', 'openclaw', '--start-hook'],
      { env: { ...s.env, PATH: s.env.PATH + path.delimiter + path.dirname(process.execPath), HOME: path.join(s.d, 'home'), GSTACK_STATE_ROOT: path.join(s.d, 'state') }, encoding: 'utf8', timeout: 240_000 });
    expect(cli.status, cli.stderr).toBe(4);
    expect(cli.stdout).toContain('start hook: written');
    expect(cli.stderr).toContain('config write refused');
    expect(cli.stderr).toContain('(HARNESS_HOOK_INACTIVE; docs/troubleshooting.md#harness-hook-inactive)');
    expect(fs.existsSync(path.join(s.profile, 'skills', 'gstack', 'SKILL.md'))).toBe(true);
  }, 300_000);

  test('without the harness on PATH the hook is written, not active, and names the commands to run', () => {
    const r = rig('openclaw', { noCli: true });
    const res = register(r.o({ startHook: true }));
    expect(res.hook).toMatchObject({ state: 'written', detail: 'openclaw is not on PATH, so gstack could not turn the plugin on or check it' });
    expect(res.hook?.fix).toBe('OPENCLAW_STATE_DIR=' + JSON.stringify(r.profile) + ' openclaw config set plugins.entries.gstack-start.hooks.allowConversationAccess true && OPENCLAW_STATE_DIR=' + JSON.stringify(r.profile) + ' openclaw config set plugins.entries.gstack-start.enabled true');
  }, 120_000);
});

describe('start hook: Hermes lifecycle and the saved choice (fake CLI)', () => {
  test('a one-run env opt-in is saved; config off then refresh turns it off; unregister removes the plugin through Hermes', () => {
    const r = rig('hermes', { env: { GSTACK_HARNESS_START_HOOK: '1' } });
    const on = register(r.o());
    expect(on.hook?.state).toBe('active');
    expect(r.calls().map(l => l.split('|')[0])).toEqual(['plugins enable gstack-start', 'plugins list --json']);

    const env = { ...r.env }; delete (env as Record<string, string | undefined>).GSTACK_HARNESS_START_HOOK;
    const kept = register({ ...r.o(), env });
    expect(kept.hook?.state).toBe('unchecked');
    expect(fs.existsSync(path.join(r.root, '__init__.py'))).toBe(true);

    fs.writeFileSync(path.join(r.o().stateRoot, 'config.yaml'), 'harness_start_hook: off\n');
    const off = register({ ...r.o(), env });
    expect(off.hook?.state).toBe('off');
    expect(r.calls().at(-1)!.split('|')[0]).toBe('plugins remove gstack-start');
    expect(fs.existsSync(path.join(r.profile, 'plugins'))).toBe(false);

    fs.writeFileSync(path.join(r.o().stateRoot, 'config.yaml'), 'harness_start_hook: on\n');
    const back = register({ ...r.o(), env });
    expect(back.hook?.state).toBe('active');
    fs.mkdirSync(path.join(r.root, '__pycache__'));
    fs.writeFileSync(path.join(r.root, '__pycache__', '__init__.cpython-312.pyc'), 'x');
    unregister(r.o().stateRoot, ROOT, 'hermes', env);
    expect(r.calls().at(-1)!.split('|')[0]).toBe('plugins remove gstack-start');
    expect(fs.existsSync(path.join(r.profile, 'plugins'))).toBe(false);
  }, 300_000);

  test('bash-only uninstall: an edited plugin file is kept and Hermes only disables it; without Hermes on PATH it prints the command', () => {
    const r = rig('hermes');
    register(r.o({ startHook: true }));
    fs.appendFileSync(path.join(r.root, 'note.txt'), 'my edit\n');
    const ledgerSh = path.join(ROOT, 'bin', 'gstack-harness-ledger.sh');
    const run = (PATH: string) => spawnSync('bash', ['-c', '. "$0" && gstack_harness_unregister_all', ledgerSh], { env: { PATH, HOME: path.join(r.d, 'home'), GSTACK_STATE_ROOT: path.join(r.d, 'state') }, encoding: 'utf8', timeout: 60_000 });
    const res = run(r.bin + path.delimiter + '/usr/bin:/bin');
    expect(res.status, res.stderr).toBe(0);
    expect(r.calls().at(-1)!.split('|')[0]).toBe('plugins disable gstack-start');
    expect(fs.readdirSync(r.root).filter(f => f.startsWith('note.txt.edited-'))).toHaveLength(1);
    expect(fs.existsSync(path.join(r.root, 'plugin.yaml'))).toBe(false);

    const s = rig('hermes');
    register(s.o({ startHook: true }));
    const t = spawnSync('bash', ['-c', '. "$0" && gstack_harness_unregister_all', ledgerSh], { env: { PATH: '/usr/bin:/bin', HOME: path.join(s.d, 'home'), GSTACK_STATE_ROOT: path.join(s.d, 'state') }, encoding: 'utf8', timeout: 60_000 });
    expect(t.status).toBe(0);
    expect(t.stdout).toContain('start hook: turn it off in Hermes yourself: HERMES_HOME="' + s.profile + '" hermes plugins disable gstack-start');
    expect(fs.existsSync(path.join(s.profile, 'plugins'))).toBe(false);
  }, 300_000);
});

describe.skipIf(process.platform === 'win32')('start hook through ./setup --host', () => {
  test('exits 4 with the skills registered when the hook does not turn on, and the next run retries it', () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.dir, 'gstack'));
    const bin = path.join(f.dir, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'openclaw'), FAKE_OPENCLAW, { mode: 0o755 });
    const profile = path.join(f.home, '.openclaw');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'fake-fail'), '');
    const PATH = bin + path.delimiter + f.env.PATH;
    const first = runSetup(f, path.join(src, 'setup'), ['--host', 'openclaw'], { env: { PATH, GSTACK_HARNESS_START_HOOK: '1' } });
    expect(first.status, first.stdout + first.stderr).toBe(4);
    expect(first.stdout).toContain('start hook: written');
    expect(first.stderr).toContain('(HARNESS_HOOK_INACTIVE; docs/troubleshooting.md#harness-hook-inactive)');
    expect(fs.existsSync(path.join(profile, 'skills', 'gstack', 'SKILL.md'))).toBe(true);
    expect(registryRows(f).map(row => row[0])).toEqual(['openclaw']);
    fs.rmSync(path.join(profile, 'fake-fail'));
    const second = runSetup(f, path.join(src, 'setup'), ['--host', 'openclaw'], { env: { PATH } });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain('start hook: active');
  }, 180_000);
});
