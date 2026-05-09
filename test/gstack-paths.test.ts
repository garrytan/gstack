import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-paths');

// Invoke via `bash` rather than executing the shebang-script directly.
// On Windows, spawnSync(scriptPath, ...) goes through CreateProcess, which
// doesn't parse `#!/usr/bin/env bash`. Production usage always sources the
// helper from inside a bash block (`eval "$(~/.claude/skills/gstack/bin/gstack-paths)"`)
// so bash is always the executor — this matches that contract.
//
// USERPROFILE: '' is a Windows-specific override. Git Bash auto-populates
// HOME from USERPROFILE at shell startup if HOME is unset/empty, which
// silently breaks the "HOME unset" test scenarios. Clearing USERPROFILE
// alongside HOME prevents that auto-population on Windows runners.
function run(env: Record<string, string | undefined>): Record<string, string> {
  const result = spawnSync('bash', [BIN], {
    env: { PATH: process.env.PATH, USERPROFILE: '', ...env } as Record<string, string>,
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
    // Skip on Windows: Git Bash auto-derives HOME from USERPROFILE,
    // HOMEDRIVE, and HOMEPATH at shell startup. Even with all three
    // cleared, bash falls back to /c/Users/<user>. The container env
    // (HOME genuinely unset) is unreachable on Windows runners. The bash
    // script's CWD fallback IS correct — exercised on Linux/Mac CI.
    if (process.platform === 'win32') return;
    const got = run({ HOME: '' });
    expect(got.GSTACK_STATE_ROOT).toBe('.gstack');
  });

  test('PLAN_ROOT chain: GSTACK_PLAN_DIR > CLAUDE_PLANS_DIR > HOME > CWD', () => {
    expect(run({ GSTACK_PLAN_DIR: '/tmp/explicit', HOME: '/h' }).PLAN_ROOT).toBe('/tmp/explicit');
    expect(run({ CLAUDE_PLANS_DIR: '/tmp/claude', HOME: '/h' }).PLAN_ROOT).toBe('/tmp/claude');
    expect(run({ HOME: '/tmp/myhome' }).PLAN_ROOT).toBe('/tmp/myhome/.claude/plans');
    // CWD fallback only verifiable on POSIX — Git Bash auto-populates HOME.
    if (process.platform !== 'win32') {
      expect(run({ HOME: '' }).PLAN_ROOT).toBe('.claude/plans');
    }
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
    const result = spawnSync('bash', [BIN], {
      env: { PATH: process.env.PATH, USERPROFILE: '', HOME: '/tmp/h' } as Record<string, string>,
      encoding: 'utf-8',
    });
    const lines = result.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      expect(line).toMatch(/^[A-Z_]+=.*/);
    }
  });
});
