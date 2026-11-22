/**
 * The enforcement hooks are opt-in and leave the advisory skills alone
 * (GST-1461): turning a gate on changes no byte of /plan-ceo-review's
 * SKILL.md. The generator renders the committed bytes with the switch on, and
 * an armed gate run writes nothing under the installed skills dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { ROOT, hookEnv, result, runHook, say, tmpDir, tool, user } from './helpers/skill-contract-fixture';

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).filter(f => fs.statSync(path.join(dir, f)).isFile()).map(f => path.join(dir, f));
}
const digest = (dir: string) => Object.fromEntries(filesUnder(dir).map(f => [path.relative(dir, f), createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));

let state = '', home = '';
beforeEach(() => { state = tmpDir('gstack-advisory-state-'); home = tmpDir('gstack-advisory-home-'); });
afterEach(() => { for (const d of [state, home]) fs.rmSync(d, { recursive: true, force: true }); });

describe('the /plan-ceo-review gate leaves its skill text alone', () => {
  test('gen:skill-docs --dry-run with ceo_review_gate on (env and config) finds plan-ceo-review fresh', () => {
    fs.writeFileSync(path.join(state, 'config.yaml'), 'ceo_review_gate: on\n');
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(ROOT, 'scripts', 'gen-skill-docs.ts'), '--dry-run'], {
      cwd: ROOT, env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_CEO_REVIEW_GATE: 'on' }, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.stdout).toContain('FRESH: plan-ceo-review/SKILL.md');
    expect(r.stdout).not.toMatch(/STALE: plan-ceo-review\//);
  });

  test('an armed CEO run that blocks a stop writes nothing under the installed skills dir', () => {
    const skills = path.join(home, '.claude', 'skills');
    fs.mkdirSync(path.join(skills, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), path.join(skills, 'plan-ceo-review', 'SKILL.md'));
    const before = digest(skills);
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, `${[user('review my plan'), tool('s1', 'Skill', { skill: 'plan-ceo-review' }), result('s1', 'Launching skill: plan-ceo-review'), say('Review complete.')].join('\n')}\n`);
    const r = runHook(path.join(ROOT, 'hosts', 'claude', 'hooks', 'ceo-review-gate.ts'),
      JSON.stringify({ session_id: 'sess-adv', transcript_path: transcript, cwd: home, hook_event_name: 'Stop', stop_hook_active: false }),
      hookEnv(state, skills, { HOME: home, GSTACK_CEO_REVIEW_GATE: 'on', GSTACK_CEO_REVIEW_OUTPUT: '' }));
    expect(JSON.parse(r.stdout).decision).toBe('block');
    expect(digest(skills)).toEqual(before);
  });
});
