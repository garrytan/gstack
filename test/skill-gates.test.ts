/**
 * gstack-skill-gates (GST-1461): settings prints a --settings JSON that
 * registers the /investigate gate headless; report counts markers from the
 * session records and exits GATE_NOT_ARMED (2) or GATE_ERRORED (3).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { gateMarker } from '../lib/skill-gates';
import { ROOT, tmpDir } from './helpers/skill-contract-fixture';

const BIN = path.join(ROOT, 'bin', 'gstack-skill-gates');
let state = '';
beforeEach(() => { state = tmpDir('gstack-skill-gates-'); });
afterEach(() => { fs.rmSync(state, { recursive: true, force: true }); });
const cli = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), BIN, ...args], { env: { PATH: process.env.PATH ?? '', HOME: state, GSTACK_STATE_ROOT: state }, encoding: 'utf8', timeout: 20_000 });
function seed(session: string, run: Record<string, unknown> | null, errors: Array<{ code: string }> = []) {
  const dir = path.join(state, 'skill-gates', session);
  fs.mkdirSync(dir, { recursive: true });
  const runs = run ? { 'investigate@3': { skill: 'investigate', load_line: 3, fired_at: '2026-11-05T00:00:00Z', blocked: 0, observed: 0, ...run } } : {};
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ version: 1, session_id: session, transcript_path: '/t', hooks: { 'investigate-gate': { runs, errors: errors.map(e => ({ at: 'x', why: 'y', ...e })), skipped: {} } } }));
}

test('the marker line has one fixed shape', () => {
  expect(gateMarker('investigate-gate', 'blocked', 'sess 1/../x', { skill: 'investigate', via: 'bash', files: 'a b.ts', n: 2 }))
    .toBe('GSTACK_GATE investigate-gate blocked session=sess1x skill=investigate via=bash files=a_b.ts n=2');
});

describe('settings', () => {
  test('--investigate registers four events on this checkout\'s shims and turns the switch on', () => {
    const r = cli('settings', '--investigate');
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.env).toEqual({ GSTACK_INVESTIGATE_GATE: 'on' });
    expect(Object.keys(s.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop']);
    expect(s.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
    for (const entries of Object.values(s.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      const cmd = entries[0].hooks[0].command;
      expect(cmd.startsWith(path.join(ROOT, 'hosts', 'claude', 'hooks', 'investigate-gate-'))).toBe(true);
      expect(fs.statSync(cmd).mode & 0o111).not.toBe(0);
    }
  });

  test('no hook named is a usage error', () => {
    const r = cli('settings');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SKILL_GATES_USAGE');
  });
});

describe('report', () => {
  test('counts fired, blocked and released per session', () => {
    seed('s1', { blocked: 2, released_at: '2026-11-05T00:01:00Z' });
    const r = cli('report', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).rows).toEqual([{ session: 's1', hook: 'investigate-gate', runs: 1, fired: 1, blocked: 2, released: 1, observed: 0, errors: 0, error_codes: [], skipped: [] }]);
  });

  test('--expect armed exits 2 GATE_NOT_ARMED for a session with no record or no fired run', () => {
    expect(cli('report', '--session', 'missing', '--expect', 'armed').status).toBe(2);
    seed('s2', null);
    const r = cli('report', '--session', 's2', '--expect', 'armed');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GATE_NOT_ARMED');
    seed('s3', {});
    expect(cli('report', '--session', 's3', '--expect', 'armed').status).toBe(0);
  });

  test('a recorded hook error exits 3 GATE_ERRORED with its code listed', () => {
    seed('s4', {}, [{ code: 'GATE_RESTORE_FAILED' }]);
    const r = cli('report');
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('errors=1 (GATE_RESTORE_FAILED)');
    expect(r.stderr).toContain('GATE_ERRORED');
  });
});
