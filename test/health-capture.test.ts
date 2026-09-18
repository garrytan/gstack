import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Execute the documented capture, so the example cannot drift from its tests.
const template = readFileSync(join(import.meta.dir, '../health/SKILL.md.tmpl'), 'utf8');
const capture = template.split('## Step 2: Run Tools')[1].match(/```bash\n([\s\S]*?)```/)![1];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runCapture(checker: string, setup = '') {
  const directory = mkdtempSync(join(tmpdir(), 'health-capture-test-'));
  temporaryDirectories.push(directory);
  const logs = join(directory, 'logs');
  mkdirSync(logs);
  const executable = join(directory, 'tsc');
  writeFileSync(executable, '#!/usr/bin/env bash\n' + checker + '\n');
  chmodSync(executable, 0o755);
  const result = spawnSync('/bin/bash', ['-euc', setup + '\n' + capture], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PATH: directory + ':' + process.env.PATH, TMPDIR: logs },
  });
  expect(result.error).toBeUndefined();
  expect(readdirSync(logs)).toEqual([]);
  return result;
}

describe('/health command capture', () => {
  test('a successful empty checker reports zero matches under set -e', () => {
    const result = runCapture('exit 0');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/TOOL:typecheck EXIT:0 DURATION:\d+s ERRORS:0/);
  });

  test('failure survives an earlier success, stderr capture, and display', () => {
    const result = runCapture('echo "source.ts: error TS2322: incorrect type" >&2\nexit 2', 'true');
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('incorrect type');
    expect(result.stdout).toMatch(/EXIT:2 DURATION:\d+s ERRORS:1/);
  });

  test('counts findings outside the displayed tail and prints only fifty log lines', () => {
    const result = runCapture([
      'for ((i=1; i<=60; i++)); do echo "source.ts: error TS2322: finding $i"; done',
      'for ((i=1; i<=80; i++)); do echo "detail $i"; done',
      'exit 2',
    ].join('\n'));
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/EXIT:2 DURATION:\d+s ERRORS:60/);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines.length).toBe(51);
    expect(lines[0]).toBe('detail 31');
    expect(lines[49]).toBe('detail 80');
  });

  test('an executed checker returning 127 remains a failure', () => {
    const result = runCapture('echo "a checker dependency failed" >&2\nexit 127');
    expect(result.status).toBe(127);
    expect(result.stdout).toContain('EXIT:127');
    expect(result.stdout).not.toContain('SKIPPED');
  });

  test('empty failing output does not inherit a successful parser status', () => {
    const result = runCapture('exit 1');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/EXIT:1 DURATION:\d+s ERRORS:0/);
  });

  test('capture log permissions are private even with a permissive caller umask', () => {
    const result = runCapture('stat -c %a "$TMPDIR"/gstack-health.* 2>/dev/null || stat -f %Lp "$TMPDIR"/gstack-health.*', 'umask 000');
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('600');
  });

  test.each([
    ['log_creation', 'mktemp() { return 1; }'],
    ['redirection', 'mktemp() { printf "%s/missing/log\\n" "$TMPDIR"; }'],
    ['parsing', 'awk() { return 2; }'],
    ['display', 'tail() { return 1; }'],
  ])('%s failure reports an error instead of a clean result', (phase, setup) => {
    const result = runCapture('exit 0', setup);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain('ERROR:typecheck CAPTURE:' + phase);
    expect(result.stdout).not.toContain('TOOL:typecheck EXIT:0');
  });
});
