/**
 * gstack-skill-gates (GST-1461): settings prints a --settings JSON that
 * registers the opt-in gates headless; report counts markers from the
 * session records and exits GATE_NOT_ARMED (2) or GATE_ERRORED (3).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { DEADLINE_MAX_MS, DEADLINE_MS, HOOK_MARGIN_MS, HOOK_TIMEOUT_S, deadlineFromEnv, gateMarker } from '../lib/skill-gates';
import { ROOT, tmpDir } from './helpers/skill-contract-fixture';

const BIN = path.join(ROOT, 'bin', 'gstack-skill-gates');
let state = '';
beforeEach(() => { state = tmpDir('gstack-skill-gates-'); });
afterEach(() => { fs.rmSync(state, { recursive: true, force: true }); });
const cli = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), BIN, ...args], { env: { PATH: process.env.PATH ?? '', HOME: state, GSTACK_STATE_ROOT: state }, encoding: 'utf8', timeout: 20_000 });
function seed(session: string, run: Record<string, unknown> | null, errors: Array<{ code: string }> = []) {
  const dir = path.join(state, 'skill-gates', session);
  fs.mkdirSync(dir, { recursive: true });
  const runs = run ? { 'plan-ceo-review@3': { skill: 'plan-ceo-review', load_line: 3, fired_at: '2026-11-05T00:00:00Z', blocked: 0, observed: 0, ...run } } : {};
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ version: 1, session_id: session, transcript_path: '/t', hooks: { 'ceo-review-gate': { runs, errors: errors.map(e => ({ at: 'x', why: 'y', ...e })), skipped: {} } } }));
}

test('the marker line has one fixed shape', () => {
  expect(gateMarker('ceo-review-gate', 'blocked', 'sess 1/../x', { skill: 'plan-ceo-review', via: 'stop', files: 'a b.md', n: 2 }))
    .toBe('GSTACK_GATE ceo-review-gate blocked session=sess1x skill=plan-ceo-review via=stop files=a_b.md n=2');
});

describe('settings', () => {
  test('--ceo-review registers Stop and SubagentStop on the ceo-review-gate shims with no matcher and turns its switch on', () => {
    const r = cli('settings', '--ceo-review');
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.env).toEqual({ GSTACK_CEO_REVIEW_GATE: 'on' });
    expect(Object.keys(s.hooks).sort()).toEqual(['Stop', 'SubagentStop']);
    for (const [event, shim] of [['Stop', 'ceo-review-gate-stop'], ['SubagentStop', 'ceo-review-gate-subagent-stop']]) {
      expect(s.hooks[event]).toHaveLength(1);
      expect(s.hooks[event][0].matcher).toBeUndefined();
      const cmd = s.hooks[event][0].hooks[0].command;
      expect(cmd).toBe(path.join(ROOT, 'hosts', 'claude', 'hooks', shim));
      expect(fs.statSync(cmd).mode & 0o111).not.toBe(0);
    }
  });

  test('--autoplan registers Stop (no matcher, GST-1666) and PreToolUse on Bash (the publish check, GST-1814) and turns its switch on', () => {
    const r = cli('settings', '--autoplan');
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.env).toEqual({ GSTACK_AUTOPLAN_GATE: 'on' });
    expect(Object.keys(s.hooks)).toEqual(['Stop', 'PreToolUse']);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].matcher).toBeUndefined();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash');
    for (const [event, shim] of [['Stop', 'autoplan-stop-gate-stop'], ['PreToolUse', 'autoplan-stop-gate-publish']]) {
      const cmd = s.hooks[event][0].hooks[0].command;
      expect(cmd).toBe(path.join(ROOT, 'hosts', 'claude', 'hooks', shim));
      expect(fs.statSync(cmd).mode & 0o111).not.toBe(0);
    }
  });

  test('--ceo-review --autoplan together: both switches on, Stop runs both gates', () => {
    const r = cli('settings', '--ceo-review', '--autoplan');
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.env).toEqual({ GSTACK_CEO_REVIEW_GATE: 'on', GSTACK_AUTOPLAN_GATE: 'on' });
    expect(Object.keys(s.hooks).sort()).toEqual(['PreToolUse', 'Stop', 'SubagentStop']);
    expect(s.hooks.Stop.map((e: { hooks: Array<{ command: string }> }) => path.basename(e.hooks[0].command))).toEqual(['ceo-review-gate-stop', 'autoplan-stop-gate-stop']);
  });

  test('a root containing a space: each command still runs its shim through sh -c', () => {
    const root = path.join(state, 'gstack root');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.copyFileSync(BIN, path.join(root, 'bin', 'gstack-skill-gates'));
    for (const dir of ['lib', 'hosts']) fs.symlinkSync(path.join(ROOT, dir), path.join(root, dir));
    const env = { PATH: process.env.PATH ?? '', HOME: state, GSTACK_STATE_ROOT: state };
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(root, 'bin', 'gstack-skill-gates'), 'settings', '--ceo-review'], { env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    const cmd = JSON.parse(r.stdout).hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('gstack root');
    const sh = spawnSync('sh', ['-c', cmd], { env, input: '', encoding: 'utf8', timeout: 20_000 });
    expect(sh.stderr).not.toMatch(/not found|No such file/);
    expect(sh.status).toBe(0);
  });

  test('no hook named is a usage error', () => {
    const r = cli('settings');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SKILL_GATES_USAGE');
  });
});

describe('hook timeout covers the gate deadline (GST-1615)', () => {
  test('every hook settings registers for both gates outlives the deadline ceiling plus the margin', () => {
    const r = cli('settings', '--ceo-review', '--autoplan');
    expect(r.status).toBe(0);
    const hooks = JSON.parse(r.stdout).hooks as Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
    const timeouts = Object.values(hooks).flatMap(entries => entries.flatMap(e => e.hooks.map(h => h.timeout)));
    expect(timeouts).toHaveLength(4);
    for (const t of timeouts) {
      expect(t * 1000).toBeGreaterThanOrEqual(DEADLINE_MAX_MS + HOOK_MARGIN_MS);
      expect(t).toBe(HOOK_TIMEOUT_S);
    }
  });

  test('hook-timeout prints HOOK_TIMEOUT_S, the number ./setup registers', () => {
    const r = cli('hook-timeout');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${HOOK_TIMEOUT_S}\n`);
  });

  test('a deadline env above the ceiling is clamped to it; zero, negative or junk falls back to the default', () => {
    expect(deadlineFromEnv({ GSTACK_SKILL_GATE_DEADLINE_MS: String(DEADLINE_MAX_MS * 3) })).toBe(DEADLINE_MAX_MS);
    expect(deadlineFromEnv({ GSTACK_SKILL_GATE_DEADLINE_MS: '1500' })).toBe(1500);
    for (const v of [undefined, '', '0', '-1', 'abc']) expect(deadlineFromEnv({ GSTACK_SKILL_GATE_DEADLINE_MS: v })).toBe(DEADLINE_MS);
  });

  test('runGateHook runs a handler under the clamped deadline, not the raw env value', () => {
    const script = `import { remainingMs, runGateHook } from ${JSON.stringify(path.join(ROOT, 'lib', 'skill-gates.ts'))};
await runGateHook('ceo-review-gate', () => true, () => ({ left: remainingMs() }));`;
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', script], {
      env: { PATH: process.env.PATH ?? '', HOME: state, GSTACK_STATE_ROOT: state, GSTACK_SKILL_GATE_DEADLINE_MS: '600000' },
      input: JSON.stringify({ session_id: 's1', transcript_path: '/t' }), encoding: 'utf8', timeout: 20_000,
    });
    expect(r.status).toBe(0);
    const { left } = JSON.parse(r.stdout);
    expect(left).toBeLessThanOrEqual(DEADLINE_MAX_MS);
    expect(left).toBeGreaterThan(DEADLINE_MAX_MS - 5000);
  });
});

describe('report', () => {
  test('counts fired, blocked and released per session', () => {
    seed('s1', { blocked: 2, released_at: '2026-11-05T00:01:00Z' });
    const r = cli('report', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).rows).toEqual([{ session: 's1', hook: 'ceo-review-gate', runs: 1, fired: 1, blocked: 2, released: 1, exhausted: 0, observed: 0, errors: 0, error_codes: [], skipped: [] }]);
  });

  test('counts a ceo-review-gate run that was exhausted after its three blocks', () => {
    const dir = path.join(state, 'skill-gates', 's5');
    fs.mkdirSync(dir, { recursive: true });
    const run = { skill: 'plan-ceo-review', load_line: 3, fired_at: '2026-11-05T00:00:00Z', blocked: 3, observed: 0, exhausted_at: '2026-11-05T00:03:00Z' };
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ version: 1, session_id: 's5', transcript_path: '/t', hooks: { 'ceo-review-gate': { runs: { 'plan-ceo-review@3': run }, errors: [], skipped: {} } } }));
    const r = cli('report', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).rows).toEqual([{ session: 's5', hook: 'ceo-review-gate', runs: 1, fired: 1, blocked: 3, released: 0, exhausted: 1, observed: 0, errors: 0, error_codes: [], skipped: [] }]);
    expect(cli('report').stdout).toContain('s5 ceo-review-gate fired=1 blocked=3 released=0 exhausted=1 observed=0 errors=0');
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

describe('headless smoke', () => {
  test('docs name the Claude Code version the smoke script pins', () => {
    const pinned = fs.readFileSync(path.join(ROOT, 'scripts', 'skill-gates-smoke.ts'), 'utf8').match(/^export const CLAUDE_CODE_VERSION = '([^']+)';$/m)?.[1];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.readFileSync(path.join(ROOT, 'docs', 'skill-gates.md'), 'utf8')).toContain(`verified at ${pinned})`);
  });
});
