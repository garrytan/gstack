import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
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
  const result = spawnSync('bash', ['-c', [
    'eval "$("$1")"',
    'printf "GSTACK_STATE_ROOT=%s\\nPLAN_ROOT=%s\\nTMP_ROOT=%s\\n" "$GSTACK_STATE_ROOT" "$PLAN_ROOT" "$TMP_ROOT"',
  ].join('\n'), 'gstack-paths-test', BIN], {
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

  test('CLAUDE_PLUGIN_DATA ignored when CLAUDE_PLUGIN_ROOT is absent or non-gstack', () => {
    // Without CLAUDE_PLUGIN_ROOT, falls through to HOME path.
    const noRoot = run({ CLAUDE_PLUGIN_DATA: '/tmp/plugin-data', HOME: '/tmp/home' });
    expect(noRoot.GSTACK_STATE_ROOT).toBe('/tmp/home/.gstack');

    // With a CLAUDE_PLUGIN_ROOT that doesn't contain "gstack" (e.g. the codex plugin),
    // still falls through to HOME path — this is the cross-plugin contamination scenario.
    const wrongRoot = run({
      CLAUDE_PLUGIN_DATA: '/tmp/codex-data',
      CLAUDE_PLUGIN_ROOT: '/tmp/openai-codex',
      HOME: '/tmp/home',
    });
    expect(wrongRoot.GSTACK_STATE_ROOT).toBe('/tmp/home/.gstack');
  });

  test('host-specific plugin paths never override the canonical runtime home', () => {
    const got = run({
      CLAUDE_PLUGIN_DATA: '/tmp/gstack-plugin-data',
      CLAUDE_PLUGIN_ROOT: '/tmp/gstack-garrytan',
      HOME: '/tmp/home',
    });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/home/.gstack');
  });

  test('HOME-derived state root when GSTACK_HOME and CLAUDE_PLUGIN_DATA unset', () => {
    const got = run({ HOME: '/tmp/myhome' });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/myhome/.gstack');
  });

  test('plans and temporary files stay under the one canonical runtime home', () => {
    expect(run({ GSTACK_PLAN_DIR: '/tmp/ignored', CLAUDE_PLANS_DIR: '/tmp/ignored-too', HOME: '/tmp/myhome' }).PLAN_ROOT)
      .toBe('/tmp/myhome/.gstack/plans');
    expect(run({ GSTACK_HOME: '/tmp/state', TMPDIR: '/tmp/ignored' }).TMP_ROOT).toBe('/tmp/state/tmp');
  });

  test('shell-looking path values remain literal when output is evaled', () => {
    const marker = `/tmp/gstack-paths-injection-${process.pid}`;
    const got = run({ GSTACK_HOME: `/tmp/state with spaces'; touch ${marker}; echo '`, HOME: '/tmp/home' });
    expect(got.GSTACK_STATE_ROOT).toContain('state with spaces');
    expect(existsSync(marker)).toBe(false);
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
    for (const line of lines) expect(line).toMatch(/^[A-Z_]+='.*'$/);
  });
});
