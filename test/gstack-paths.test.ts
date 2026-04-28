import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-paths');

function run(env: Record<string, string | undefined>): Record<string, string> {
  const result = spawnSync(BIN, [], {
    env: { PATH: process.env.PATH, ...env } as Record<string, string>,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`gstack-paths failed (status ${result.status}): ${result.stderr}`);
  }
  const out: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe('gstack-paths', () => {
  test('GSTACK_HOME wins over CLAUDE_PLUGIN_DATA and HOME', () => {
    const got = run({
      GSTACK_HOME: '/tmp/explicit-state',
      CLAUDE_PLUGIN_DATA: '/tmp/plugin-data',
      HOME: '/tmp/home',
    });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/explicit-state');
  });

  test('CLAUDE_PLUGIN_DATA wins over HOME when GSTACK_HOME unset', () => {
    const got = run({
      CLAUDE_PLUGIN_DATA: '/tmp/plugin-data',
      HOME: '/tmp/home',
    });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/plugin-data');
  });

  test('HOME-derived state root when GSTACK_HOME and CLAUDE_PLUGIN_DATA unset', () => {
    const got = run({ HOME: '/tmp/myhome' });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/myhome/.gstack');
  });

  test('CWD fallback when HOME also unset (container env)', () => {
    const got = run({ HOME: '' });
    expect(got.GSTACK_STATE_ROOT).toBe('.gstack');
  });

  test('PLAN_ROOT chain: GSTACK_PLAN_DIR > CLAUDE_PLANS_DIR > HOME > CWD', () => {
    expect(run({ GSTACK_PLAN_DIR: '/tmp/explicit', HOME: '/h' }).PLAN_ROOT).toBe('/tmp/explicit');
    expect(run({ CLAUDE_PLANS_DIR: '/tmp/claude', HOME: '/h' }).PLAN_ROOT).toBe('/tmp/claude');
    expect(run({ HOME: '/tmp/myhome' }).PLAN_ROOT).toBe('/tmp/myhome/.claude/plans');
    expect(run({ HOME: '' }).PLAN_ROOT).toBe('.claude/plans');
  });

  test('TMP_ROOT chain: TMPDIR > TMP > .gstack/tmp', () => {
    expect(run({ TMPDIR: '/tmp/x', HOME: '/h' }).TMP_ROOT).toBe('/tmp/x');
    expect(run({ TMP: '/tmp/y', HOME: '/h' }).TMP_ROOT).toBe('/tmp/y');
    expect(run({ HOME: '' }).TMP_ROOT).toBe('.gstack/tmp');
  });

  test('emits all three exports on every invocation', () => {
    const got = run({ HOME: '/tmp/h' });
    expect(got).toHaveProperty('GSTACK_STATE_ROOT');
    expect(got).toHaveProperty('PLAN_ROOT');
    expect(got).toHaveProperty('TMP_ROOT');
  });

  test('output is shell-evalable: only KEY=VALUE lines, no extra prose', () => {
    const result = spawnSync(BIN, [], {
      env: { PATH: process.env.PATH, HOME: '/tmp/h' } as Record<string, string>,
      encoding: 'utf-8',
    });
    const lines = result.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      expect(line).toMatch(/^[A-Z_]+=.*/);
    }
  });
});
