/**
 * The enforcement hooks are opt-in and leave the advisory skills alone
 * (GST-1461): turning a gate on changes no byte of /investigate's or
 * /plan-ceo-review's SKILL.md. The generator renders the committed bytes with
 * the switch on, the skill sources never name the gate, and an armed gate run
 * writes nothing under the installed skills dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { ROOT, hookEnv, result, runHook, tmpDir, tool, user } from './helpers/skill-contract-fixture';

const ADVISORY = ['investigate', 'plan-ceo-review'];
const GATE_NAMES = /investigate[-_]gate|GSTACK_GATE|skill-gates/;

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).filter(f => fs.statSync(path.join(dir, f)).isFile()).map(f => path.join(dir, f));
}
const digest = (dir: string) => Object.fromEntries(filesUnder(dir).map(f => [path.relative(dir, f), createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));

let state = '', home = '';
beforeEach(() => { state = tmpDir('gstack-advisory-state-'); home = tmpDir('gstack-advisory-home-'); });
afterEach(() => { for (const d of [state, home]) fs.rmSync(d, { recursive: true, force: true }); });

describe('advisory skill text is byte-identical with the gate on', () => {
  test('gen:skill-docs --dry-run with investigate_gate on (env and config) finds both skills fresh', () => {
    fs.writeFileSync(path.join(state, 'config.yaml'), 'investigate_gate: on\n');
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(ROOT, 'scripts', 'gen-skill-docs.ts'), '--dry-run'], {
      cwd: ROOT, env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_INVESTIGATE_GATE: 'on' }, encoding: 'utf8', timeout: 120_000,
    });
    for (const skill of ADVISORY) expect(r.stdout).toContain(`FRESH: ${skill}/SKILL.md`);
    expect(r.stdout).not.toMatch(/STALE: (investigate|plan-ceo-review)\//);
  });

  test('the advisory skill sources never name the gate: the hooks attach from settings, not from the skill', () => {
    for (const skill of ADVISORY) {
      for (const f of filesUnder(path.join(ROOT, skill))) expect({ f, hit: GATE_NAMES.test(fs.readFileSync(f, 'utf8')) }).toEqual({ f, hit: false });
    }
  });

  test('an armed gate run that blocks an edit writes nothing under the installed skills dir', () => {
    const skills = path.join(home, '.claude', 'skills');
    for (const skill of ADVISORY) {
      fs.mkdirSync(path.join(skills, skill), { recursive: true });
      fs.copyFileSync(path.join(ROOT, skill, 'SKILL.md'), path.join(skills, skill, 'SKILL.md'));
    }
    const before = digest(skills);
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1;\n');
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-q', '-m', 'seed']]) {
      expect(spawnSync('git', args, { cwd: repo, timeout: 10_000 }).status).toBe(0);
    }
    const target = path.join(repo, 'app.ts');
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, `${[user('fix it'), tool('s1', 'Skill', { skill: 'investigate' }), result('s1', 'Launching skill: investigate'), tool('e1', 'Edit', { file_path: target })].join('\n')}\n`);
    const r = runHook(path.join(ROOT, 'hosts', 'claude', 'hooks', 'investigate-gate.ts'),
      JSON.stringify({ session_id: 'sess-adv', transcript_path: transcript, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: target }, tool_use_id: 'e1' }),
      hookEnv(state, skills, { HOME: home, GSTACK_INVESTIGATE_GATE: 'on' }));
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(digest(skills)).toEqual(before);
  });
});
