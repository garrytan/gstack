/**
 * setup: the skill_routing and skill_contracts gates (GST-1088, lane A). The
 * _skill_hook_gate function is lifted out of setup and run against the real
 * gstack-config and gstack-settings-hook with a temp state root and a temp
 * settings.json: default off registers nothing, a flag persists and registers
 * once with a one-time line, a typo warns and is not persisted, and off
 * removes the registration. Static pins cover the flags and the parse gate.
 * Each switch's default lives only in SWITCH_DEFAULT (lib/skill-route.ts): a
 * copy with one table line flipped changes what setup registers, what
 * gstack-config reports and what the hook does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SWITCH_DEFAULT } from '../lib/skill-route';
import {
  J1_TRANSCRIPT, ROOT, hookEnv, runHook, skillsDir, tmpDir,
} from './helpers/skill-contract-fixture';

const setupSrc = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const settingsHookSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), 'utf8');
const gateFn = setupSrc.slice(setupSrc.indexOf('_skill_hook_gate() {'), setupSrc.indexOf('\n}\n', setupSrc.indexOf('_skill_hook_gate() {')) + 3);

let state = '', home = '';
beforeEach(() => { state = tmpDir('gstack-gate-state-'); home = tmpDir('gstack-gate-home-'); });
afterEach(() => { for (const d of [state, home]) fs.rmSync(d, { recursive: true, force: true }); });

const settingsFile = () => path.join(home, 'settings.json');
const settings = () => (fs.existsSync(settingsFile()) ? JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) : {});

const GATES = {
  skill_routing: 'GSTACK_SKILL_ROUTING UserPromptSubmit "$2/hosts/claude/hooks/skill-route-hook" gstack-skill-route 5 "routing hint"',
  skill_contracts: 'GSTACK_SKILL_CONTRACTS Stop "$2/hosts/claude/hooks/skill-contract-stop-hook" gstack-skill-contract 10 "contract check"',
};

/** Run one gate once from the checkout at root: mode is the flag value ("" = none). */
function gate(mode: string, env: Record<string, string> = {}, noTeam = 0, root = ROOT, key: keyof typeof GATES = 'skill_routing'): { code: number | null; out: string } {
  const script = [
    'set -e',
    'log() { printf "%s\\n" "$*"; }',
    'GSTACK_CONFIG="$2/bin/gstack-config"',
    `SETTINGS_HOOK="${path.join(ROOT, 'bin', 'gstack-settings-hook')}"`,
    'SKILL_ROUTE_BIN="$2/bin/gstack-skill-route"',
    `IS_WINDOWS=0; NO_TEAM_MODE=${noTeam}`,
    gateFn,
    `_skill_hook_gate ${key} "$1" ${GATES[key]}`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script, 'gate', mode, root], {
    env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_STATE_ROOT: state, GSTACK_SETTINGS_FILE: settingsFile(), ...env },
    encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const config = () => (fs.existsSync(path.join(state, 'config.yaml')) ? fs.readFileSync(path.join(state, 'config.yaml'), 'utf8') : '');
const registered = (event = 'UserPromptSubmit') => (settings().hooks?.[event] ?? []) as Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;

describe('setup: skill hook gates', () => {
  test('flags parse for both switches, and both appear in --help', () => {
    for (const f of ['--skill-routing)', '--no-skill-routing)', '--skill-routing=*)', '--skill-contracts)', '--no-skill-contracts)', '--skill-contracts=*)']) {
      expect(setupSrc).toContain(`    ${f}`);
    }
    expect(setupSrc).toContain('--skill-routing --no-skill-routing --skill-contracts --no-skill-contracts');
    expect(setupSrc).toContain('--skill-routing / --no-skill-routing');
    expect(setupSrc).toContain('--skill-contracts / --no-skill-contracts');
  });

  test('both hooks resolve through _hook_command_path literals (the parse gate and hook-check see them), with KNOWN_HOOKS rows', () => {
    expect(setupSrc).toContain('_hook_command_path hosts/claude/hooks/skill-route-hook ||');
    expect(setupSrc).toContain('_hook_command_path hosts/claude/hooks/skill-contract-stop-hook ||');
    expect(settingsHookSrc).toContain('"skill-route-hook":         { source: "gstack-skill-route", event: "UserPromptSubmit", matcher: "", relpath: "hosts/claude/hooks/skill-route-hook" }');
    expect(settingsHookSrc).toContain('"skill-contract-stop-hook": { source: "gstack-skill-contract", event: "Stop", matcher: "", relpath: "hosts/claude/hooks/skill-contract-stop-hook" }');
    expect(setupSrc).toMatch(/_skill_hook_gate skill_contracts "\$SKILL_CONTRACTS_MODE" GSTACK_SKILL_CONTRACTS Stop \\\n  "\$SKILL_CONTRACT_HOOK" gstack-skill-contract 10/);
  });

  test('no flag, env or config: SWITCH_DEFAULT decides, and nothing is persisted', () => {
    const g = gate('');
    expect(g.code).toBe(0);
    if (SWITCH_DEFAULT.skill_routing === 'on') {
      expect(g.out).toContain('registered UserPromptSubmit hook: routing hint (on via default;');
      expect(registered()).toHaveLength(1);
    } else {
      expect(g.out).toBe('');
      expect(registered()).toEqual([]);
    }
    expect(config()).not.toContain('skill_routing');
  });

  test('an unreadable config: warns, registers nothing and removes a live registration, whatever the default', () => {
    gate('on');
    fs.rmSync(path.join(state, 'config.yaml'));
    fs.mkdirSync(path.join(state, 'config.yaml'));
    const g = gate('');
    expect(g.out).toContain("WARNING: cannot read skill_routing from config — using 'off' for this run whatever the default");
    expect(registered()).toEqual([]);
  });

  test('flag on: persists, registers a schema-valid entry with a one-time line; a re-run is quiet', () => {
    const first = gate('on');
    expect(first.code).toBe(0);
    expect(first.out).toContain('registered UserPromptSubmit hook: routing hint (on via flag; turn off: gstack-config set skill_routing off, or ./setup --no-skill-routing');
    expect(config()).toMatch(/^skill_routing: on$/m);
    const entries = registered();
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks).toHaveLength(1);
    expect(entries[0].hooks[0]).toMatchObject({ type: 'command', timeout: 5 });
    expect(entries[0].hooks[0].command).toEndWith('hosts/claude/hooks/skill-route-hook');
    expect(gate('')).toEqual({ code: 0, out: '' });
    expect(registered()).toHaveLength(1);
  });

  test('env on registers without persisting; a typo warns, takes SWITCH_DEFAULT and is not persisted', () => {
    expect(gate('', { GSTACK_SKILL_ROUTING: 'yes' }).out).toContain('on via env GSTACK_SKILL_ROUTING');
    expect(config()).not.toContain('skill_routing');
    const typo = gate('onn');
    expect(typo.out).toContain(`WARNING: unrecognized skill_routing value 'onn' (from flag) — using default '${SWITCH_DEFAULT.skill_routing}' for this run, not persisting`);
    expect(config()).not.toContain('skill_routing');
    expect(registered()).toHaveLength(SWITCH_DEFAULT.skill_routing === 'on' ? 1 : 0);
  });

  test('off removes a live registration, and so does --no-team', () => {
    gate('on');
    expect(registered()).toHaveLength(1);
    gate('off');
    expect(registered()).toEqual([]);
    expect(config()).toMatch(/^skill_routing: off$/m);
    gate('on');
    gate('', {}, 1);
    expect(registered()).toEqual([]);
  });
});

describe('SWITCH_DEFAULT is the one default (a flip PR changes one line)', () => {
  const TABLE = path.join('lib', 'skill-route.ts');
  const original = fs.readFileSync(path.join(ROOT, TABLE), 'utf8');
  const other = (v: 'on' | 'off') => (v === 'on' ? 'off' : 'on');
  let copy = '', skills = '', work = '';
  beforeAll(() => {
    copy = tmpDir('gstack-switch-default-');
    fs.cpSync(path.join(ROOT, 'lib'), path.join(copy, 'lib'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'hosts', 'claude', 'hooks'), path.join(copy, 'hosts', 'claude', 'hooks'), { recursive: true });
    for (const f of ['gstack-config', 'gstack-state-root.sh', 'gstack-skill-route']) fs.cpSync(path.join(ROOT, 'bin', f), path.join(copy, 'bin', f));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'));
    skills = skillsDir(['investigate']);
    work = tmpDir('gstack-switch-default-work-');
  });
  afterAll(() => { for (const d of [copy, skills, work]) fs.rmSync(d, { recursive: true, force: true }); });

  /** Write the copy's table with only this switch's line flipped, prove the diff is that one line, and return the new default. */
  function flip(key: keyof typeof GATES): 'on' | 'off' {
    const line = `  ${key}: '${SWITCH_DEFAULT[key]}',`;
    const next = other(SWITCH_DEFAULT[key]);
    expect(original.split('\n').filter(l => l === line)).toHaveLength(1);
    const flipped = original.replace(line, `  ${key}: '${next}',`);
    expect(flipped.split('\n').filter((l, i) => l !== original.split('\n')[i])).toEqual([`  ${key}: '${next}',`]);
    fs.writeFileSync(path.join(copy, TABLE), flipped);
    return next;
  }
  const configAt = (root: string, ...args: string[]) => spawnSync(path.join(root, 'bin', 'gstack-config'), args, {
    env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_STATE_ROOT: state }, encoding: 'utf8', timeout: 30_000,
  });
  const routeAt = (root: string, env: Record<string, string> = {}) => runHook(path.join(root, 'hosts', 'claude', 'hooks', 'skill-route-hook.ts'),
    JSON.stringify({ session_id: 'sess-d', transcript_path: '/tmp/t.jsonl', cwd: work, hook_event_name: 'UserPromptSubmit', prompt: 'please fix this bug in login' }),
    hookEnv(state, skills, env));
  const stopAt = (root: string) => {
    const file = path.join(work, 'transcript.jsonl');
    fs.writeFileSync(file, `${J1_TRANSCRIPT.join('\n')}\n`);
    fs.rmSync(path.join(state, 'skill-contracts'), { recursive: true, force: true });
    return runHook(path.join(root, 'hosts', 'claude', 'hooks', 'skill-contract-stop-hook.ts'),
      JSON.stringify({ session_id: 'sess-d', transcript_path: file, cwd: work, hook_event_name: 'Stop', stop_hook_active: false }),
      hookEnv(state, skills));
  };
  const routes = (r: { stdout: string }) => r.stdout !== '' && JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('/investigate');
  const blocks = (r: { stdout: string }) => r.stdout !== '' && JSON.parse(r.stdout).decision === 'block';
  /** Every reader at root agrees that the switches default to want. */
  function expectReaders(root: string, want: Record<keyof typeof GATES, 'on' | 'off'>): void {
    for (const key of ['skill_routing', 'skill_contracts'] as const) {
      const get = configAt(root, 'get', key);
      expect({ key, code: get.status, out: get.stdout }).toEqual({ key, code: 0, out: want[key] });
      expect(configAt(root, 'get', '--stored', key).stdout).toBe('unset');
      expect(configAt(root, 'defaults').stdout).toMatch(new RegExp(`^ {2}${key}: +${want[key]}$`, 'm'));
      const g = gate('', {}, 0, root, key);
      expect(registered(key === 'skill_routing' ? 'UserPromptSubmit' : 'Stop')).toHaveLength(want[key] === 'on' ? 1 : 0);
      if (want[key] === 'on') expect(g.out).toContain('(on via default;');
      else expect(g.out).toBe('');
    }
    expect(routes(routeAt(root))).toBe(want.skill_routing === 'on');
    expect(blocks(stopAt(root))).toBe(want.skill_contracts === 'on');
    expect(config()).toBe('');
  }

  test('pin: skill_routing defaults to off today (a flip PR changes lib/skill-route.ts line 39 and this pin)', () => {
    expect(original.split('\n')[38]).toBe("  skill_routing: 'off',");
    expect(SWITCH_DEFAULT.skill_routing).toBe('off');
  });

  test('pin: skill_contracts defaults to off today (a flip PR changes lib/skill-route.ts line 40 and this pin)', () => {
    expect(original.split('\n')[39]).toBe("  skill_contracts: 'off',");
    expect(SWITCH_DEFAULT.skill_contracts).toBe('off');
  });

  test('every reader agrees with SWITCH_DEFAULT: gstack-config, setup, the routing hook and the Stop hook', () => {
    expectReaders(ROOT, SWITCH_DEFAULT);
  });

  test('an absent key reads empty from gstack-config get, never "false"', () => {
    const r = configAt(ROOT, 'get', 'no_such_key_gst1088');
    expect({ code: r.status, out: r.stdout }).toEqual({ code: 1, out: '' });
  });

  test('flipping skill_routing alone moves every reader; an explicit config value still wins', () => {
    const next = flip('skill_routing');
    expectReaders(copy, { ...SWITCH_DEFAULT, skill_routing: next });
    expect(configAt(copy, 'set', 'skill_routing', SWITCH_DEFAULT.skill_routing).status).toBe(0);
    gate('', {}, 0, copy);
    expect(registered()).toHaveLength(SWITCH_DEFAULT.skill_routing === 'on' ? 1 : 0);
    expect(routes(routeAt(copy))).toBe(SWITCH_DEFAULT.skill_routing === 'on');
  });

  test('flipping skill_contracts alone moves every reader', () => {
    const next = flip('skill_contracts');
    expectReaders(copy, { ...SWITCH_DEFAULT, skill_contracts: next });
  });

  test('a typo takes the flipped default in setup and in the hook', () => {
    const next = flip('skill_routing');
    const typo = gate('onn', {}, 0, copy);
    expect(typo.out).toContain(`WARNING: unrecognized skill_routing value 'onn' (from flag) — using default '${next}' for this run, not persisting`);
    expect(registered()).toHaveLength(next === 'on' ? 1 : 0);
    expect(routes(routeAt(copy, { GSTACK_SKILL_ROUTING: 'onn' }))).toBe(next === 'on');
    expect(routes(routeAt(ROOT, { GSTACK_SKILL_ROUTING: 'onn' }))).toBe(SWITCH_DEFAULT.skill_routing === 'on');
  });
});
