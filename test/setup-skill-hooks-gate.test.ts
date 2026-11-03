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

  test('default off: nothing registered, nothing persisted', () => {
    expect(gate('')).toEqual({ code: 0, out: '' });
    expect(registered()).toEqual([]);
    expect(config()).not.toContain('skill_routing');
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

  test('env on registers without persisting; a typo warns, applies off and is not persisted', () => {
    expect(gate('', { GSTACK_SKILL_ROUTING: 'yes' }).out).toContain('on via env GSTACK_SKILL_ROUTING');
    expect(config()).not.toContain('skill_routing');
    const typo = gate('onn');
    expect(typo.out).toContain("WARNING: unrecognized skill_routing value 'onn' (from flag) — using default 'off' for this run, not persisting");
    expect(config()).not.toContain('skill_routing');
    expect(registered()).toEqual([]);
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

  /** Write the copy's table with only this switch's line flipped to on, and prove the diff is that one line. */
  function flip(key: keyof typeof GATES): void {
    const line = `  ${key}: 'off',`;
    expect(original.split('\n').filter(l => l === line)).toHaveLength(1);
    const flipped = original.replace(line, `  ${key}: 'on',`);
    const changed = flipped.split('\n').filter((l, i) => l !== original.split('\n')[i]);
    expect(changed).toEqual([`  ${key}: 'on',`]);
    fs.writeFileSync(path.join(copy, TABLE), flipped);
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
    return runHook(path.join(root, 'hosts', 'claude', 'hooks', 'skill-contract-stop-hook.ts'),
      JSON.stringify({ session_id: 'sess-d', transcript_path: file, cwd: work, hook_event_name: 'Stop', stop_hook_active: false }),
      hookEnv(state, skills));
  };

  test('both defaults are off today, and every reader agrees', () => {
    expect(original).toContain("export const SWITCH_DEFAULT: Record<SwitchName, 'on' | 'off'> = {\n  skill_routing: 'off',\n  skill_contracts: 'off',\n};");
    for (const key of ['skill_routing', 'skill_contracts']) {
      const get = configAt(ROOT, 'get', key);
      expect({ code: get.status, out: get.stdout }).toEqual({ code: 0, out: 'off' });
      expect(configAt(ROOT, 'get', '--stored', key).stdout).toBe('unset');
    }
    expect(configAt(ROOT, 'defaults').stdout).toMatch(/^ {2}skill_routing: +off$/m);
    expect(gate('').out).toBe('');
    expect(routeAt(ROOT)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(stopAt(ROOT)).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test('an absent key reads empty from gstack-config get, never "false"', () => {
    const r = configAt(ROOT, 'get', 'no_such_key_gst1088');
    expect({ code: r.status, out: r.stdout }).toEqual({ code: 1, out: '' });
  });

  test('flipping skill_routing alone: setup registers, gstack-config reports on, the hook routes; config off still wins', () => {
    flip('skill_routing');
    expect(configAt(copy, 'get', 'skill_routing').stdout).toBe('on');
    expect(configAt(copy, 'get', 'skill_contracts').stdout).toBe('off');
    expect(configAt(copy, 'defaults').stdout).toMatch(/^ {2}skill_routing: +on$/m);
    const g = gate('', {}, 0, copy);
    expect(g.out).toContain('registered UserPromptSubmit hook: routing hint (on via default;');
    expect(registered()).toHaveLength(1);
    expect(config()).not.toContain('skill_routing');
    const hint = routeAt(copy);
    expect(hint.code).toBe(0);
    expect(JSON.parse(hint.stdout).hookSpecificOutput.additionalContext).toContain('/investigate');
    expect(stopAt(copy).stdout).toBe('');

    expect(configAt(copy, 'set', 'skill_routing', 'off').status).toBe(0);
    gate('', {}, 0, copy);
    expect(registered()).toEqual([]);
    expect(routeAt(copy).stdout).toBe('');
  });

  test('flipping skill_contracts alone: setup registers the Stop hook and the hook blocks', () => {
    flip('skill_contracts');
    const g = gate('', {}, 0, copy, 'skill_contracts');
    expect(g.out).toContain('registered Stop hook: contract check (on via default;');
    expect(registered('Stop')).toHaveLength(1);
    expect(registered()).toEqual([]);
    expect(JSON.parse(stopAt(copy).stdout).decision).toBe('block');
    expect(routeAt(copy).stdout).toBe('');
  });

  test('a typo takes the flipped default in setup and in the hook', () => {
    flip('skill_routing');
    const typo = gate('onn', {}, 0, copy);
    expect(typo.out).toContain("WARNING: unrecognized skill_routing value 'onn' (from flag) — using default 'on' for this run, not persisting");
    expect(registered()).toHaveLength(1);
    expect(JSON.parse(routeAt(copy, { GSTACK_SKILL_ROUTING: 'onn' }).stdout).hookSpecificOutput.additionalContext).toContain('/investigate');
    expect(routeAt(ROOT, { GSTACK_SKILL_ROUTING: 'onn' }).stdout).toBe('');
  });
});
