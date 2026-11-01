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
import { HOOK_ID, START_NOTE, START_NOTE_MAX, hookChoice, hookFiles, inspectHook } from '../lib/harness-start-hook';
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
[ -f "$d/fake-kill" ] && { rm -f "$d/fake-kill"; kill -9 "$PPID"; sleep 5; }
[ -f "$d/fake-noisy" ] && echo "[plugins] gstack-start: cannot verify where this plugin came from"
[ -f "$d/fake-hang" ] && [ "$1" = plugins ] && exec sleep 40
touch "$c"
acc=false; grep -q '^plugins.entries.gstack-start.hooks.allowConversationAccess=true$' "$c" && acc=true
en=$(grep '^plugins.entries.gstack-start.enabled=' "$c" | tail -1 | cut -d= -f2); enj=null; [ -n "$en" ] && enj=$en
case "$1 $2" in
  "config set") echo "$3=$4" >> "$c" ;;
  "config unset") grep -v "^$3" "$c" > "$c.t"; mv "$c.t" "$c" ;;
  "config get") api=""; grep -q '^plugins.entries.gstack-start.hooks.allowPromptInjection=false$' "$c" && api=',"allowPromptInjection":false'
    printf '{"allow":%s,"deny":%s,"entries":{"gstack-start":{"enabled":%s,"hooks":{"allowConversationAccess":%s%s}}}}\n' "$(cat "$d/fake-allow" 2>/dev/null || echo null)" "$(cat "$d/fake-deny" 2>/dev/null || echo null)" "$enj" "$acc" "$api" ;;
  "plugins inspect")
    hooks=""; [ -d "$d/extensions/gstack-start" ] && [ "$acc" = true ] && [ "$en" != false ] && hooks='{"name":"before_prompt_build"}'
    printf '{"plugin":{"status":"loaded","enabled":%s},"typedHooks":[%s]}\n' "$([ "$en" = false ] && echo false || echo true)" "$hooks" ;;
esac
case "$1 $2" in "config set"|"config unset")
  j="$d/openclaw.json"; b="$d/fake-base.json"
  [ -f "$b" ] || { if [ -f "$j" ]; then cp "$j" "$b"; else printf '{"meta":{"lastTouchedVersion":"fake"}}' > "$b"; fi; }
  acc=false; grep -q '^plugins.entries.gstack-start.hooks.allowConversationAccess=true$' "$c" && acc=true
  en=$(grep '^plugins.entries.gstack-start.enabled=' "$c" | tail -1 | cut -d= -f2); enj=null; [ -n "$en" ] && enj=$en
  if grep -q '^plugins.entries.gstack-start' "$c"; then printf '%s,"plugins":{"entries":{"gstack-start":{"enabled":%s,"hooks":{"allowConversationAccess":%s}}}}}' "$(sed 's/}$//' "$b")" "$enj" "$acc" > "$j"; else cp "$b" "$j"; fi ;;
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
case "$1 $2" in "plugins enable"|"plugins disable"|"plugins remove")
  y="$d/config.yaml"; b="$d/fake-base.yaml"
  [ -f "$b" ] || { if [ -f "$y" ]; then cp "$y" "$b"; else : > "$b"; fi; }
  s=$(cat "$d/fake-state" 2>/dev/null)
  { cat "$b"; [ -z "$s" ] || printf 'plugins:\n  %s:\n  - gstack-start\n' "$s"; } > "$y.t"; mv "$y.t" "$y" ;;
esac
`;
/** A configured harness: what each harness's own setup leaves (OpenClaw onboarding, hermes setup) before gstack runs. */
const HEALTHY = { openclaw: '{"agents":{"defaults":{"model":{"primary":"anthropic/claude-opus-5-5"}}},"gateway":{"mode":"local"}}', hermes: 'model:\n  default: claude-opus-5-5\n  provider: anthropic\nterminal:\n  backend: local\n' };
const CONFIG = { openclaw: 'openclaw.json', hermes: 'config.yaml' };

/** A temp home, state root and profile, with fake openclaw and hermes CLIs first on PATH. */
function rig(target: 'openclaw' | 'hermes', extra: { noCli?: boolean; fresh?: boolean; env?: Record<string, string> } = {}) {
  const d = tmp();
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'openclaw'), FAKE_OPENCLAW, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hermes'), FAKE_HERMES, { mode: 0o755 });
  const profile = path.join(d, target === 'openclaw' ? 'oc' : 'he');
  fs.mkdirSync(profile, { recursive: true });
  const config = path.join(profile, CONFIG[target]);
  if (!extra.fresh) fs.writeFileSync(config, HEALTHY[target]);
  const env = { PATH: (extra.noCli ? '' : bin + path.delimiter) + '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sekret', [target === 'openclaw' ? 'OPENCLAW_STATE_DIR' : 'HERMES_HOME']: profile, ...extra.env };
  const o = (more: Partial<RegisterOptions> = {}): RegisterOptions => ({ target: TARGETS[target], checkout: ROOT, stateRoot: path.join(d, 'state'), env, home: path.join(d, 'home'), version: VERSION, ...more });
  const root = path.join(profile, target === 'openclaw' ? 'extensions' : 'plugins', HOOK_ID);
  const calls = () => fs.existsSync(path.join(profile, 'fake-calls')) ? fs.readFileSync(path.join(profile, 'fake-calls'), 'utf8').trim().split('\n') : [];
  return { d, bin, profile, config, env, o, root, calls };
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
    expect(() => register({ ...s.o({ startHook: true }), env: { ...s.env, OPENCLAW_CONFIG_PATH: '/elsewhere/openclaw.json' } })).toThrow(expect.objectContaining({ code: 'HARNESS_HOOK_UNSUPPORTED' }));
    for (const x of [r, s]) { expect(fs.existsSync(path.join(x.profile, 'skills'))).toBe(false); expect(x.calls()).toEqual([]); }
    expect(fs.existsSync(path.join(s.d, 'custom'))).toBe(false);
  });

  test('a plugin folder gstack did not write, or a symlink on the way to it, stops an explicit --start-hook with nothing written, and turns an env or config opt-in into hook off', () => {
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
    const viaEnv = register({ ...s.o(), env: { ...s.env, GSTACK_HARNESS_START_HOOK: '1' } });
    expect(viaEnv.hook?.state).toBe('off');
    expect(viaEnv.hook?.detail).toContain('is a symlink (env asked for the hook');
    expect(fs.existsSync(path.join(s.profile, 'skills', 'gstack'))).toBe(true);
    expect(fs.readdirSync(path.join(s.d, 'elsewhere'))).toEqual([]);
    expect(r.calls().concat(s.calls())).toEqual([]);
  });

  test('a file, an empty folder or a folder with any non-kept file at the plugin path is still owned elsewhere', () => {
    for (const make of [(root: string) => fs.writeFileSync(root, 'x'), (root: string) => fs.mkdirSync(path.join(root, 'sub'), { recursive: true }),
      (root: string) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'note.txt.edited-2026-11-01T06-31-18-911Z'), 'kept'); fs.writeFileSync(path.join(root, 'plugin.yaml'), 'mine'); }]) {
      const r = rig('hermes');
      fs.mkdirSync(path.dirname(r.root), { recursive: true });
      make(r.root);
      expect(() => register(r.o({ startHook: true }))).toThrow(expect.objectContaining({ code: 'HARNESS_HOOK_OWNED_ELSEWHERE' }));
      expect(register({ ...r.o(), env: { ...r.env, GSTACK_HARNESS_START_HOOK: '1' } }).hook?.state).toBe('off');
    }
  }, 300_000);

  test('a profile path with a trailing slash under a symlinked parent still takes the hook and is saved without the slash', () => {
    const r = rig('hermes');
    const link = path.join(tmp(), 'ln');
    fs.symlinkSync(r.d, link);
    const res = register({ ...r.o({ startHook: true }), env: { ...r.env, HERMES_HOME: path.join(link, 'he') + '/' } });
    expect(res.hook?.state).toBe('active');
    expect(readLedger(res.ledger)!.meta.hook_profile).toBe(path.join(link, 'he'));
    expect(fs.existsSync(path.join(r.root, 'plugin.yaml'))).toBe(true);
  }, 120_000);
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

  test('a run killed during activation leaves the hook marked not active, so the next plain register activates it', () => {
    const r = rig('openclaw');
    fs.writeFileSync(path.join(r.profile, 'fake-kill'), '');
    const cli = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin', 'gstack-harness'), 'register', 'openclaw'],
      { env: { ...r.env, GSTACK_HARNESS_START_HOOK: '1', PATH: r.env.PATH + path.delimiter + path.dirname(process.execPath), HOME: path.join(r.d, 'home'), GSTACK_STATE_ROOT: path.join(r.d, 'state') }, encoding: 'utf8', timeout: 240_000 });
    expect(cli.signal, cli.stderr).toBe('SIGKILL');
    const dir = path.join(r.d, 'state', 'harness');
    const lfile = fs.readdirSync(dir).find(f => f.endsWith('.ledger'));
    expect(readLedger(path.join(dir, lfile!))!.meta).toMatchObject({ start_hook: 'on', hook_active: 'no' });
    const next = register(r.o());
    expect(next.hook).toMatchObject({ state: 'active', retried: true });
    expect(readLedger(next.ledger)!.meta.hook_active).toBe('yes');
  }, 300_000);

  test('off with an edited plugin file keeps the edit, and the same registration can turn the hook back on', () => {
    const r = rig('openclaw');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    fs.writeFileSync(path.join(r.root, 'note.txt'), 'my note\n');
    const off = register(r.o({ startHook: false }));
    expect(off.kept).toHaveLength(1);
    expect(off.kept[0]).toMatch(/note\.txt\.edited-/);
    const on = register(r.o({ startHook: true }));
    expect(on.hook?.state).toBe('active');
    expect(fs.readFileSync(path.join(r.root, 'note.txt'), 'utf8')).toBe(START_NOTE + '\n');
    expect(fs.readFileSync(off.kept[0], 'utf8')).toBe('my note\n');
  }, 300_000);

  test('an explicit --start-hook on an unchanged registration killed during activation is retried by the next run', () => {
    const r = rig('openclaw');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    fs.writeFileSync(path.join(r.profile, 'fake-kill'), '');
    const cli = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin', 'gstack-harness'), 'register', 'openclaw', '--start-hook'],
      { env: { ...r.env, PATH: r.env.PATH + path.delimiter + path.dirname(process.execPath), HOME: path.join(r.d, 'home'), GSTACK_STATE_ROOT: path.join(r.d, 'state') }, encoding: 'utf8', timeout: 240_000 });
    expect(cli.signal, cli.stderr).toBe('SIGKILL');
    const dir = path.join(r.d, 'state', 'harness');
    expect(readLedger(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.ledger'))!))!.meta.hook_active).toBe('no');
    expect(register(r.o()).hook).toMatchObject({ state: 'active', retried: true });
  }, 300_000);

  test('a log line in brackets before the harness JSON still reads back as active', () => {
    const r = rig('openclaw');
    fs.writeFileSync(path.join(r.profile, 'fake-noisy'), '');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    expect(inspectHook('openclaw', r.profile, r.env, path.join(r.d, 'home')).state).toBe('active');
  }, 120_000);

  test('a hung harness read-back gives up after a short timeout', () => {
    const r = rig('openclaw');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    fs.writeFileSync(path.join(r.profile, 'fake-hang'), '');
    const t0 = Date.now();
    expect(inspectHook('openclaw', r.profile, r.env, path.join(r.d, 'home')).state).toBe('written');
    expect(Date.now() - t0).toBeLessThan(35_000);
  }, 120_000);

  test('without the harness on PATH the hook is written, not active, and names the commands to run', () => {
    const r = rig('openclaw', { noCli: true });
    const res = register(r.o({ startHook: true }));
    expect(res.hook).toMatchObject({ state: 'written', detail: 'openclaw is not on PATH, so gstack could not turn the plugin on or check it' });
    expect(res.hook?.fix).toBe('OPENCLAW_STATE_DIR=' + JSON.stringify(r.profile) + ' openclaw config set plugins.entries.gstack-start.hooks.allowConversationAccess true && OPENCLAW_STATE_DIR=' + JSON.stringify(r.profile) + ' openclaw config set plugins.entries.gstack-start.enabled true');
  }, 120_000);
});

describe('start hook: read back and retry (fake CLI)', () => {
  test('OpenClaw deny lists and allowPromptInjection false read back as written; a Hermes disable reads back as disabled', () => {
    const r = rig('openclaw');
    fs.mkdirSync(r.root, { recursive: true });
    const cfg = (line: string) => fs.appendFileSync(path.join(r.profile, 'fake-config'), line + '\n');
    cfg('plugins.entries.gstack-start.hooks.allowConversationAccess=true');
    expect(inspectHook('openclaw', r.profile, r.env, r.d).state).toBe('active');
    fs.writeFileSync(path.join(r.profile, 'fake-deny'), '["gstack-start"]');
    expect(inspectHook('openclaw', r.profile, r.env, r.d)).toMatchObject({ state: 'written', detail: 'plugins.deny lists gstack-start' });
    fs.rmSync(path.join(r.profile, 'fake-deny'));
    cfg('plugins.entries.gstack-start.hooks.allowPromptInjection=false');
    expect(inspectHook('openclaw', r.profile, r.env, r.d)).toMatchObject({ state: 'written', detail: 'plugins.entries.gstack-start.hooks.allowPromptInjection is false' });
    const h = rig('hermes');
    fs.mkdirSync(h.root, { recursive: true });
    fs.writeFileSync(path.join(h.profile, 'fake-state'), 'disabled');
    expect(inspectHook('hermes', h.profile, h.env, h.d)).toMatchObject({ state: 'disabled' });
  });

  test('after a failed opt-in, refresh retries without failing, and stops for good once the user disables the plugin', () => {
    const r = rig('openclaw');
    fs.writeFileSync(path.join(r.profile, 'fake-allow'), '["anthropic"]');
    expect(register(r.o({ startHook: true })).hook).toMatchObject({ state: 'written', required: true });
    expect(readLedger(register(r.o()).ledger)!.meta.hook_active).toBe('no');
    const retry = register(r.o());
    expect(retry.hook).toMatchObject({ state: 'written', required: false, retried: true });
    fs.rmSync(path.join(r.profile, 'fake-allow'));
    const fixed = register(r.o());
    expect(fixed.hook).toMatchObject({ state: 'active', retried: true });
    expect(readLedger(fixed.ledger)!.meta.hook_active).toBe('yes');
    const sets = r.calls().filter(l => l.startsWith('config set')).length;
    expect(register(r.o()).hook?.state).toBe('unchecked');
    expect(r.calls().filter(l => l.startsWith('config set')).length).toBe(sets);

    const s = rig('openclaw');
    fs.writeFileSync(path.join(s.profile, 'fake-fail'), '');
    expect(register(s.o({ startHook: true })).hook?.state).toBe('written');
    fs.rmSync(path.join(s.profile, 'fake-fail'));
    fs.appendFileSync(path.join(s.profile, 'fake-config'), 'plugins.entries.gstack-start.enabled=false\n');
    const before = s.calls().filter(l => l.startsWith('config set')).length;
    const left = register(s.o());
    expect(left.hook).toMatchObject({ state: 'disabled', retried: true });
    expect(readLedger(left.ledger)!.meta.hook_active).toBe('disabled');
    register(s.o());
    expect(s.calls().filter(l => l.startsWith('config set')).length).toBe(before);
    expect(fs.readFileSync(path.join(s.profile, 'fake-config'), 'utf8')).toContain('enabled=false');
  }, 300_000);
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

describe('start hook: teardown keeps what gstack did not write (fake CLI)', () => {
  test('a kept copy of an edited Hermes plugin file survives unregister: Hermes only disables the plugin', () => {
    const r = rig('hermes');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    fs.writeFileSync(path.join(r.root, 'note.txt'), 'my note\n');
    const again = register(r.o());
    expect(again.kept).toHaveLength(1);
    unregister(r.o().stateRoot, ROOT, 'hermes', r.env);
    expect(r.calls().at(-1)!.split('|')[0]).toBe('plugins disable gstack-start');
    expect(fs.readFileSync(again.kept[0], 'utf8')).toBe('my note\n');
  }, 300_000);

  test('a plugins folder swapped for a symlink after registration: off refuses, unregister deletes nothing through it', () => {
    const r = rig('hermes');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    const elsewhere = path.join(r.d, 'elsewhere');
    fs.renameSync(path.join(r.profile, 'plugins'), elsewhere);
    fs.symlinkSync(elsewhere, path.join(r.profile, 'plugins'));
    fs.writeFileSync(path.join(elsewhere, HOOK_ID, 'important.txt'), 'keep');
    expect(() => register(r.o({ startHook: false }))).toThrow(expect.objectContaining({ code: 'HARNESS_UNSAFE_DESTINATION' }));
    unregister(r.o().stateRoot, ROOT, 'hermes', r.env);
    expect(r.calls().some(l => l.startsWith('plugins remove'))).toBe(false);
    expect(fs.readdirSync(path.join(elsewhere, HOOK_ID)).sort()).toEqual(['__init__.py', 'important.txt', 'note.txt', 'plugin.yaml']);
  }, 300_000);

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an opt-out that fails to delete the plugin files can be run again', () => {
    const r = rig('openclaw');
    const on = register(r.o({ startHook: true }));
    expect(on.hook?.state).toBe('active');
    fs.chmodSync(r.root, 0o555);
    try {
      expect(() => register(r.o({ startHook: false }))).toThrow(/EACCES/);
      expect(readLedger(on.ledger)!.meta.hook_root).toBe(r.root);
    } finally { fs.chmodSync(r.root, 0o755); }
    const ext = path.join(r.profile, 'extensions'), moved = path.join(r.d, 'moved');
    fs.renameSync(ext, moved);
    fs.symlinkSync(moved, ext);
    expect(() => register(r.o({ startHook: false }))).toThrow(expect.objectContaining({ code: 'HARNESS_UNSAFE_DESTINATION' }));
    expect(() => register({ ...r.o(), env: { ...r.env, GSTACK_HARNESS_START_HOOK: '1' } })).toThrow(expect.objectContaining({ code: 'HARNESS_UNSAFE_DESTINATION' }));
    expect(fs.existsSync(path.join(moved, HOOK_ID, 'index.js'))).toBe(true);
    fs.unlinkSync(ext);
    fs.renameSync(moved, ext);
    const off = register(r.o({ startHook: false }));
    expect(off.hook?.state).toBe('off');
    expect(fs.existsSync(path.join(r.profile, 'extensions'))).toBe(false);
    expect(readLedger(off.ledger)!.meta.hook_root).toBeUndefined();
  }, 300_000);

  test('unregister leaves an empty plugin folder alone when the folder above it was swapped for a symlink', () => {
    const r = rig('openclaw');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    const ext = path.join(r.profile, 'extensions'), elsewhere = path.join(r.d, 'elsewhere');
    fs.renameSync(ext, path.join(r.d, 'old'));
    fs.mkdirSync(path.join(elsewhere, HOOK_ID), { recursive: true });
    fs.symlinkSync(elsewhere, ext);
    unregister(r.o().stateRoot, ROOT, 'openclaw', r.env);
    expect(fs.existsSync(path.join(elsewhere, HOOK_ID))).toBe(true);
  }, 300_000);

  test('a saved opt-in survives one run from a shell that sets OPENCLAW_CONFIG_PATH', () => {
    const r = rig('openclaw');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    const res = register({ ...r.o(), env: { ...r.env, OPENCLAW_CONFIG_PATH: '/elsewhere/openclaw.json' } });
    expect(res.hook?.state).not.toBe('off');
    expect(r.calls().some(l => l.startsWith('config unset'))).toBe(false);
    expect(fs.existsSync(path.join(r.root, 'index.js'))).toBe(true);
    expect(readLedger(res.ledger)!.meta.start_hook).toBe('on');
  }, 300_000);
});

describe('start hook: HARN-18 smoke defects (GST-778)', () => {
  const offPath = (r: { env: Record<string, string> }) => ({ ...r.env, PATH: '/usr/bin:/bin' });
  const cli = (r: { bin: string; env: Record<string, string> }, t: 'openclaw' | 'hermes', ...args: string[]) => spawnSync(path.join(r.bin, t), args, { env: r.env, encoding: 'utf8', timeout: 30_000 });

  test('OPENCLAW_CONFIG_PATH naming the profile own openclaw.json, even through a symlink, keeps the hook', () => {
    const r = rig('openclaw');
    const link = path.join(tmp(), 'ln');
    fs.symlinkSync(r.profile, link);
    const viaEnv = register({ ...r.o(), env: { ...r.env, GSTACK_HARNESS_START_HOOK: '1', OPENCLAW_CONFIG_PATH: path.join(link, 'openclaw.json') } });
    expect(viaEnv.hook).toMatchObject({ state: 'active', required: true });
    const s = rig('openclaw');
    expect(register({ ...s.o({ startHook: true }), env: { ...s.env, OPENCLAW_CONFIG_PATH: s.config } }).hook?.state).toBe('active');
  }, 120_000);

  test('a foreign OPENCLAW_CONFIG_PATH still turns an env opt-in off, and says so as a failure with the fix', () => {
    const r = rig('openclaw');
    const res = register({ ...r.o(), env: { ...r.env, GSTACK_HARNESS_START_HOOK: '1', OPENCLAW_CONFIG_PATH: path.join(r.d, 'elsewhere', 'openclaw.json') } });
    expect(res.hook).toMatchObject({ state: 'off', required: true });
    expect(res.hook?.detail).toContain('OPENCLAW_CONFIG_PATH points OpenClaw at ' + path.join(r.d, 'elsewhere', 'openclaw.json'));
    expect(res.hook?.fix).toContain('unset OPENCLAW_CONFIG_PATH or set it to ' + r.config);
    expect(r.calls()).toEqual([]);
    expect(fs.existsSync(path.join(r.profile, 'extensions'))).toBe(false);
    expect(readLedger(res.ledger)!.meta.start_hook).toBe('off');
    expect(fs.readFileSync(r.config, 'utf8')).toBe(HEALTHY.openclaw);
  }, 120_000);

  test('a fresh harness with no config: turning the hook on creates no config, runs no harness command, and fails with the setup to run first', () => {
    for (const t of ['openclaw', 'hermes'] as const) {
      const r = rig(t, { fresh: true });
      const res = register(r.o({ startHook: true }));
      expect(res.hook).toMatchObject({ state: 'written', required: true });
      expect(res.hook?.detail).toContain('no ' + (t === 'openclaw' ? 'OpenClaw' : 'Hermes') + ' config at ' + r.config);
      expect(res.hook?.fix).toContain(t === 'openclaw' ? 'openclaw onboard' : 'hermes setup');
      expect(fs.existsSync(r.config)).toBe(false);
      expect(r.calls()).toEqual([]);
      expect(fs.existsSync(path.join(r.profile, 'skills'))).toBe(true);
      expect(readLedger(res.ledger)!.meta.hook_active).toBe('no');
    }
  }, 300_000);

  test('once the harness setup has written its config, the next refresh turns the hook on and changes only the plugin entry', () => {
    const o = rig('openclaw', { fresh: true });
    register(o.o({ startHook: true }));
    fs.writeFileSync(o.config, HEALTHY.openclaw);
    expect(register(o.o()).hook).toMatchObject({ state: 'active', retried: true });
    const json = JSON.parse(fs.readFileSync(o.config, 'utf8'));
    expect(json.plugins).toEqual({ entries: { [HOOK_ID]: { enabled: true, hooks: { allowConversationAccess: true } } } });
    delete json.plugins;
    expect(json).toEqual(JSON.parse(HEALTHY.openclaw));
    expect(o.calls().filter(l => l.startsWith('config set')).map(l => l.split('|')[0])).toEqual(['config set plugins.entries.gstack-start.hooks.allowConversationAccess true', 'config set plugins.entries.gstack-start.enabled true']);

    const h = rig('hermes', { fresh: true });
    register(h.o({ startHook: true }));
    fs.writeFileSync(h.config, HEALTHY.hermes);
    expect(register(h.o()).hook).toMatchObject({ state: 'active', retried: true });
    expect(fs.readFileSync(h.config, 'utf8')).toBe(HEALTHY.hermes + 'plugins:\n  enabled:\n  - gstack-start\n');
  }, 300_000);

  test('turning off or unregistering a hook that never turned on, in a harness with no config, creates no config', () => {
    for (const t of ['openclaw', 'hermes'] as const) {
      const r = rig(t, { fresh: true });
      register(r.o({ startHook: true }));
      if (t === 'openclaw') expect(register(r.o({ startHook: false })).hook?.state).toBe('off');
      else unregister(r.o().stateRoot, ROOT, 'hermes', r.env);
      expect(fs.existsSync(r.config)).toBe(false);
      expect(r.calls()).toEqual([]);
      expect(fs.existsSync(r.root)).toBe(false);
    }
  }, 300_000);

  test('Hermes status without hermes on PATH (its own terminal tool) reads the hook from config.yaml', () => {
    const r = rig('hermes');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    const row = () => status(r.o().stateRoot, VERSION, offPath(r)).find(s => s.target === 'hermes')!.hook!;
    expect(row()).toMatchObject({ state: 'active' });
    expect(row().detail).toContain('hermes is not on PATH');
    cli(r, 'hermes', 'plugins', 'disable', HOOK_ID);
    expect(row().state).toBe('disabled');
    fs.writeFileSync(r.config, HEALTHY.hermes);
    expect(row().state).toBe('written');
    fs.writeFileSync(r.config, 'plugins: [unclosed\n');
    expect(row()).toMatchObject({ state: 'unknown' });
    expect(row().detail).toContain('hermes is not on PATH');
  }, 120_000);

  test('OpenClaw status without openclaw on PATH is unknown when openclaw.json turns the hook on, disabled when the user turned it off', () => {
    const r = rig('openclaw');
    expect(register(r.o({ startHook: true })).hook?.state).toBe('active');
    const row = () => status(r.o().stateRoot, VERSION, offPath(r)).find(s => s.target === 'openclaw')!.hook!;
    expect(row()).toMatchObject({ state: 'unknown' });
    expect(row().detail).toContain('openclaw is not on PATH');
    cli(r, 'openclaw', 'config', 'set', 'plugins.entries.gstack-start.enabled', 'false');
    expect(row().state).toBe('disabled');
    expect(status(r.o().stateRoot, VERSION, r.env).find(s => s.target === 'openclaw')!.hook!.state).toBe('disabled');
  }, 120_000);
});


describe.skipIf(process.platform === 'win32')('start hook through ./setup --host', () => {
  test('OPENCLAW_CONFIG_PATH naming the profile own config keeps an env opt-in on; a foreign one exits 4 with the hook off', () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.dir, 'gstack'));
    const bin = path.join(f.dir, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'openclaw'), FAKE_OPENCLAW, { mode: 0o755 });
    const profile = path.join(f.home, '.openclaw');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'openclaw.json'), HEALTHY.openclaw);
    const PATH = bin + path.delimiter + f.env.PATH;
    const own = runSetup(f, path.join(src, 'setup'), ['--host', 'openclaw'], { env: { PATH, GSTACK_HARNESS_START_HOOK: '1', OPENCLAW_CONFIG_PATH: path.join(profile, 'openclaw.json') } });
    expect(own.status, own.stdout + own.stderr).toBe(0);
    expect(own.stdout).toContain('start hook: active');
    const g = makeFixture();
    const gsrc = makeSource(g, path.join(g.dir, 'gstack'));
    fs.mkdirSync(path.join(g.home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(g.home, '.openclaw', 'openclaw.json'), HEALTHY.openclaw);
    const foreign = runSetup(g, path.join(gsrc, 'setup'), ['--host', 'openclaw'], { env: { PATH: bin + path.delimiter + g.env.PATH, GSTACK_HARNESS_START_HOOK: '1', OPENCLAW_CONFIG_PATH: path.join(g.dir, 'other', 'openclaw.json') } });
    expect(foreign.status, foreign.stdout + foreign.stderr).toBe(4);
    expect(foreign.stdout).toContain('start hook: off');
    expect(foreign.stderr).toContain('(HARNESS_HOOK_INACTIVE; docs/troubleshooting.md#harness-hook-inactive)');
    expect(foreign.stderr).toContain('OPENCLAW_CONFIG_PATH');
    expect(fs.existsSync(path.join(g.home, '.openclaw', 'skills', 'gstack', 'SKILL.md'))).toBe(true);
  }, 300_000);

  test('exits 4 with the skills registered when the hook does not turn on, and the next run retries it', () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.dir, 'gstack'));
    const bin = path.join(f.dir, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'openclaw'), FAKE_OPENCLAW, { mode: 0o755 });
    const profile = path.join(f.home, '.openclaw');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'openclaw.json'), HEALTHY.openclaw);
    fs.writeFileSync(path.join(profile, 'fake-fail'), '');
    const PATH = bin + path.delimiter + f.env.PATH;
    const first = runSetup(f, path.join(src, 'setup'), ['--host', 'openclaw'], { env: { PATH, GSTACK_HARNESS_START_HOOK: '1' } });
    expect(first.status, first.stdout + first.stderr).toBe(4);
    expect(first.stdout).toContain('start hook: written');
    expect(first.stderr).toContain('(HARNESS_HOOK_INACTIVE; docs/troubleshooting.md#harness-hook-inactive)');
    expect(fs.existsSync(path.join(profile, 'skills', 'gstack', 'SKILL.md'))).toBe(true);
    expect(registryRows(f).map(row => row[0])).toEqual(['openclaw']);
    const refreshed = runSetup(f, path.join(src, 'setup'), ['--refresh-registered'], { env: { PATH } });
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(refreshed.stdout + refreshed.stderr).toContain('start hook: written');
    fs.rmSync(path.join(profile, 'fake-fail'));
    const second = runSetup(f, path.join(src, 'setup'), ['--host', 'openclaw'], { env: { PATH } });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain('start hook: active');
  }, 180_000);
});
