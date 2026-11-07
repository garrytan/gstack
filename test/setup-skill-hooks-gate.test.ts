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
import { HOOK_TIMEOUT_S } from '../lib/skill-gates';
import { SWITCH_DEFAULT } from '../lib/skill-route';
import {
  J1_TRANSCRIPT, ROOT, hookEnv, runHook, skillsDir, tmpDir,
} from './helpers/skill-contract-fixture';

const setupSrc = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const settingsHookSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), 'utf8');
const gateFn = setupSrc.slice(setupSrc.indexOf('_skill_hook_gate() {'), setupSrc.indexOf('\n}\n', setupSrc.indexOf('_skill_hook_gate() {')) + 3);
const gateTimeoutLine = setupSrc.match(/^SKILL_GATE_HOOK_TIMEOUT=.*$/m)?.[0] ?? 'echo "setup has no SKILL_GATE_HOOK_TIMEOUT line" >&2; exit 9';

let state = '', home = '';
beforeEach(() => { state = tmpDir('gstack-gate-state-'); home = tmpDir('gstack-gate-home-'); });
afterEach(() => { for (const d of [state, home]) fs.rmSync(d, { recursive: true, force: true }); });

const settingsFile = () => path.join(home, 'settings.json');
const settings = () => (fs.existsSync(settingsFile()) ? JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) : {});

const GATES = {
  skill_routing: 'GSTACK_SKILL_ROUTING UserPromptSubmit "$2/hosts/claude/hooks/skill-route-hook" gstack-skill-route 5 "routing hint"',
  skill_contracts: 'GSTACK_SKILL_CONTRACTS Stop "$2/hosts/claude/hooks/skill-contract-stop-hook" gstack-skill-contract 10 "contract check"',
  ceo_review_gate: 'GSTACK_CEO_REVIEW_GATE Stop "$2/hosts/claude/hooks/ceo-review-gate-stop" gstack-ceo-review-gate "$SKILL_GATE_HOOK_TIMEOUT" "ceo review gate" ""'
    + ' SubagentStop "$2/hosts/claude/hooks/ceo-review-gate-subagent-stop" ""',
  autoplan_gate: 'GSTACK_AUTOPLAN_GATE Stop "$2/hosts/claude/hooks/autoplan-stop-gate-stop" gstack-autoplan-gate "$SKILL_GATE_HOOK_TIMEOUT" "autoplan gate" ""'
    + ' PreToolUse "$2/hosts/claude/hooks/autoplan-stop-gate-publish" Bash',
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
    'SOURCE_GSTACK_DIR="$2"',
    gateTimeoutLine,
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
    skills = skillsDir(['verify']);
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
  const routes = (r: { stdout: string }) => r.stdout !== '' && JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('/verify');
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

  test('pin: skill_routing defaults to off today (a flip PR changes lib/skill-route.ts line 41 and this pin)', () => {
    expect(original.split('\n')[40]).toBe("  skill_routing: 'off',");
    expect(SWITCH_DEFAULT.skill_routing).toBe('off');
  });

  test('pin: skill_contracts defaults to off today (a flip PR changes lib/skill-route.ts line 42 and this pin)', () => {
    expect(original.split('\n')[41]).toBe("  skill_contracts: 'off',");
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

describe('setup: the retired /investigate gate loses its old registration (GST-1717)', () => {
  const EVENTS: Array<[string, string, string | undefined]> = [
    ['PreToolUse', 'investigate-gate-pre', 'Edit|Write|MultiEdit|NotebookEdit|Bash'],
    ['PostToolUse', 'investigate-gate-post', 'Bash'],
    ['PostToolUseFailure', 'investigate-gate-post-failure', 'Bash'],
    ['Stop', 'investigate-gate-stop', undefined],
  ];
  const removal = setupSrc.match(/^.*remove-source --source gstack-investigate-gate.*$/m)?.[0] ?? 'echo "setup has no gstack-investigate-gate removal" >&2; exit 9';
  const hook = (...args: string[]) => spawnSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), args, {
    env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_SETTINGS_FILE: settingsFile() }, encoding: 'utf8', timeout: 30_000,
  });

  test('no flag or switch is left, and the KNOWN_HOOKS rows stay so the old entries are recognized', () => {
    expect(setupSrc).not.toContain('--investigate-gate');
    expect(setupSrc).not.toContain('INVESTIGATE_GATE');
    for (const [event, shim] of EVENTS) {
      const row = settingsHookSrc.slice(settingsHookSrc.indexOf('"' + shim + '":'), settingsHookSrc.indexOf('}', settingsHookSrc.indexOf('"' + shim + '":')));
      expect(row).toContain('source: "gstack-investigate-gate"');
      expect(row).toContain('event: "' + event + '"');
    }
  });

  test('setup removes all four events an earlier setup registered, and leaves the other gates', () => {
    for (const [event, shim, matcher] of EVENTS) {
      const r = hook('ensure-event', '--event', event, '--command', path.join(ROOT, 'hosts', 'claude', 'hooks', shim), '--source', 'gstack-investigate-gate', ...(matcher ? ['--matcher', matcher] : []));
      expect(r.status, r.stderr).toBe(0);
    }
    const ceo = hook('ensure-event', '--event', 'Stop', '--command', path.join(ROOT, 'hosts', 'claude', 'hooks', 'ceo-review-gate-stop'), '--source', 'gstack-ceo-review-gate');
    expect(ceo.status, ceo.stderr).toBe(0);
    const ours = (event: string) => registered(event).filter(e => e.hooks.some(h => h.command.includes('investigate-gate')));
    for (const [event] of EVENTS) expect(ours(event)).toHaveLength(1);
    const r = spawnSync('bash', ['-c', 'SETTINGS_HOOK="$1"\n' + removal, 'setup', path.join(ROOT, 'bin', 'gstack-settings-hook')], {
      env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_SETTINGS_FILE: settingsFile() }, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    for (const [event] of EVENTS) expect(ours(event)).toEqual([]);
    expect(registered('Stop').some(e => e.hooks.some(h => h.command.endsWith('ceo-review-gate-stop')))).toBe(true);
  });
});

describe('setup: the ceo_review_gate switch (GST-1461) registers Stop and SubagentStop', () => {
  const EVENTS: Array<[string, string]> = [
    ['Stop', 'ceo-review-gate-stop'],
    ['SubagentStop', 'ceo-review-gate-subagent-stop'],
  ];
  const ours = (event: string) => registered(event).filter(e => e.hooks.some(h => h.command.includes('ceo-review-gate')));

  test('flags parse, appear in --help and the typo list, and each shim has a KNOWN_HOOKS row with its event', () => {
    for (const flag of ['--ceo-review-gate)', '--no-ceo-review-gate)', '--ceo-review-gate=*)']) expect(setupSrc).toContain(`    ${flag}`);
    expect(setupSrc).toContain('--ceo-review-gate / --no-ceo-review-gate');
    expect(setupSrc).toContain('--ceo-review-gate --no-ceo-review-gate');
    for (const [event, shim] of EVENTS) {
      expect(setupSrc).toContain(`_hook_command_path hosts/claude/hooks/${shim} ||`);
      const row = settingsHookSrc.slice(settingsHookSrc.indexOf(`"${shim}":`), settingsHookSrc.indexOf('}', settingsHookSrc.indexOf(`"${shim}":`)));
      expect(row).toContain('source: "gstack-ceo-review-gate"');
      expect(row).toContain(`event: "${event}"`);
      expect(row).toContain('matcher: ""');
    }
  });

  test('pin: ceo_review_gate defaults to off, so with no flag, env or config nothing registers', () => {
    expect(SWITCH_DEFAULT.ceo_review_gate).toBe('off');
    expect(gate('', {}, 0, ROOT, 'ceo_review_gate')).toEqual({ code: 0, out: '' });
    for (const [event] of EVENTS) expect(ours(event)).toEqual([]);
  });

  test('flag on: persists and registers both events; a re-run is quiet; off removes both', () => {
    const first = gate('on', {}, 0, ROOT, 'ceo_review_gate');
    expect(first.code).toBe(0);
    expect(first.out).toContain('registered Stop hook: ceo review gate (on via flag; turn off: gstack-config set ceo_review_gate off, or ./setup --no-ceo-review-gate');
    expect(first.out).toContain('registered SubagentStop hook: ceo review gate');
    expect(config()).toMatch(/^ceo_review_gate: on$/m);
    for (const [event, shim] of EVENTS) {
      const entries = ours(event) as Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].matcher ?? undefined).toBeUndefined();
      expect(entries[0].hooks[0].command).toEndWith(`hosts/claude/hooks/${shim}`);
      expect(entries[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_S);
    }
    expect(gate('', {}, 0, ROOT, 'ceo_review_gate')).toEqual({ code: 0, out: '' });
    gate('off', {}, 0, ROOT, 'ceo_review_gate');
    for (const [event] of EVENTS) expect(ours(event)).toEqual([]);
  });

  test('gstack-config knows the key and its default', () => {
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-config'), ['defaults'], { env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_STATE_ROOT: state }, encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toMatch(/^ {2}ceo_review_gate: +off$/m);
  });
});

describe('setup: the autoplan_gate switch (GST-1666) registers Stop, and PreToolUse on Bash for the publish check (GST-1814)', () => {
  const ours = () => registered('Stop').filter(e => e.hooks.some(h => h.command.includes('autoplan-stop-gate')));
  const publish = () => registered('PreToolUse').filter(e => e.hooks.some(h => h.command.includes('autoplan-stop-gate'))) as Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>;

  test('flags parse, appear in --help and the typo list, and the shim has a KNOWN_HOOKS row with its event', () => {
    for (const flag of ['--autoplan-gate)', '--no-autoplan-gate)', '--autoplan-gate=*)']) expect(setupSrc).toContain(`    ${flag}`);
    expect(setupSrc).toContain('--autoplan-gate / --no-autoplan-gate');
    expect(setupSrc).toContain('--autoplan-gate --no-autoplan-gate');
    expect(setupSrc).toContain('_hook_command_path hosts/claude/hooks/autoplan-stop-gate-stop ||');
    expect(setupSrc).toContain('"$AUTOPLAN_GATE_STOP" gstack-autoplan-gate "$SKILL_GATE_HOOK_TIMEOUT" \\');
    const row = settingsHookSrc.slice(settingsHookSrc.indexOf('"autoplan-stop-gate-stop":'), settingsHookSrc.indexOf('}', settingsHookSrc.indexOf('"autoplan-stop-gate-stop":')));
    expect(row).toContain('source: "gstack-autoplan-gate"');
    expect(row).toContain('event: "Stop"');
    expect(row).toContain('matcher: ""');
    expect(setupSrc).toContain('_hook_command_path hosts/claude/hooks/autoplan-stop-gate-publish ||');
    expect(setupSrc).toContain('  PreToolUse "$AUTOPLAN_GATE_PUBLISH" Bash');
    const pub = settingsHookSrc.slice(settingsHookSrc.indexOf('"autoplan-stop-gate-publish":'), settingsHookSrc.indexOf('}', settingsHookSrc.indexOf('"autoplan-stop-gate-publish":')));
    expect(pub).toContain('source: "gstack-autoplan-gate"');
    expect(pub).toContain('event: "PreToolUse"');
    expect(pub).toContain('matcher: "Bash"');
  });

  test('pin: autoplan_gate defaults to off, so with no flag, env or config nothing registers', () => {
    expect(SWITCH_DEFAULT.autoplan_gate).toBe('off');
    expect(gate('', {}, 0, ROOT, 'autoplan_gate')).toEqual({ code: 0, out: '' });
    expect(ours()).toEqual([]);
    expect(publish()).toEqual([]);
  });

  test('flag on: persists and registers Stop and PreToolUse; a re-run is quiet; off removes both', () => {
    const first = gate('on', {}, 0, ROOT, 'autoplan_gate');
    expect(first.code).toBe(0);
    expect(first.out).toContain('registered Stop hook: autoplan gate (on via flag; turn off: gstack-config set autoplan_gate off, or ./setup --no-autoplan-gate');
    expect(config()).toMatch(/^autoplan_gate: on$/m);
    const entries = ours() as Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher ?? undefined).toBeUndefined();
    expect(entries[0].hooks[0].command).toEndWith('hosts/claude/hooks/autoplan-stop-gate-stop');
    expect(entries[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_S);
    expect(publish()).toHaveLength(1);
    expect(publish()[0].matcher).toBe('Bash');
    expect(publish()[0].hooks[0].command).toEndWith('hosts/claude/hooks/autoplan-stop-gate-publish');
    expect(publish()[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_S);
    expect(gate('', {}, 0, ROOT, 'autoplan_gate')).toEqual({ code: 0, out: '' });
    gate('off', {}, 0, ROOT, 'autoplan_gate');
    expect(ours()).toEqual([]);
    expect(publish()).toEqual([]);
  });

  test('gstack-config knows the key and its default', () => {
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-config'), ['defaults'], { env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_STATE_ROOT: state }, encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toMatch(/^ {2}autoplan_gate: +off$/m);
  });
});

describe('setup: both skill gates register the hook timeout lib/skill-gates.ts derives (GST-1615)', () => {
  test('source: one SKILL_GATE_HOOK_TIMEOUT from gstack-skill-gates hook-timeout, passed to both gates', () => {
    expect(gateTimeoutLine).toBe('SKILL_GATE_HOOK_TIMEOUT="$(bun --no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}" "$SOURCE_GSTACK_DIR/bin/gstack-skill-gates" hook-timeout 2>/dev/null || true)"');
    expect(setupSrc).toContain('"$CEO_REVIEW_GATE_STOP" gstack-ceo-review-gate "$SKILL_GATE_HOOK_TIMEOUT" \\');
    expect(setupSrc).not.toMatch(/gstack-(ceo-review|autoplan)-gate \d/);
  });

  test('the setup line evaluates to HOOK_TIMEOUT_S', () => {
    const r = spawnSync('bash', ['-c', `SOURCE_GSTACK_DIR="$1"\n${gateTimeoutLine}\nprintf %s "$SKILL_GATE_HOOK_TIMEOUT"`, 'gate', ROOT], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toBe(String(HOOK_TIMEOUT_S));
  });
});
