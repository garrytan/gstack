/**
 * setup: the skill_routing and skill_contracts gates (GST-1088, lane A). The
 * _skill_hook_gate function is lifted out of setup and run against the real
 * gstack-config and gstack-settings-hook with a temp state root and a temp
 * settings.json: default off registers nothing, a flag persists and registers
 * once with a one-time line, a typo warns and is not persisted, and off
 * removes the registration. Static pins cover the flags and the parse gate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROOT, tmpDir } from './helpers/skill-contract-fixture';

const setupSrc = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const settingsHookSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), 'utf8');
const gateFn = setupSrc.slice(setupSrc.indexOf('_skill_hook_gate() {'), setupSrc.indexOf('\n}\n', setupSrc.indexOf('_skill_hook_gate() {')) + 3);

let state = '', home = '';
beforeEach(() => { state = tmpDir('gstack-gate-state-'); home = tmpDir('gstack-gate-home-'); });
afterEach(() => { for (const d of [state, home]) fs.rmSync(d, { recursive: true, force: true }); });

const settingsFile = () => path.join(home, 'settings.json');
const settings = () => (fs.existsSync(settingsFile()) ? JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) : {});

/** Run the routing gate once: mode is the flag value ("" = none). */
function gate(mode: string, env: Record<string, string> = {}, noTeam = 0): { code: number | null; out: string } {
  const hook = path.join(ROOT, 'hosts', 'claude', 'hooks', 'skill-route-hook');
  const script = [
    'set -e',
    'log() { printf "%s\\n" "$*"; }',
    `GSTACK_CONFIG="${path.join(ROOT, 'bin', 'gstack-config')}"`,
    `SETTINGS_HOOK="${path.join(ROOT, 'bin', 'gstack-settings-hook')}"`,
    `IS_WINDOWS=0; NO_TEAM_MODE=${noTeam}`,
    gateFn,
    `_skill_hook_gate skill_routing "$1" GSTACK_SKILL_ROUTING UserPromptSubmit "${hook}" gstack-skill-route 5 "routing hint"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script, 'gate', mode], {
    env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_STATE_ROOT: state, GSTACK_SETTINGS_FILE: settingsFile(), ...env },
    encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const config = () => (fs.existsSync(path.join(state, 'config.yaml')) ? fs.readFileSync(path.join(state, 'config.yaml'), 'utf8') : '');
const registered = () => (settings().hooks?.UserPromptSubmit ?? []) as Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;

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
