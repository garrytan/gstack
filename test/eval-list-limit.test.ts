import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'eval-list.ts');

function run(args: string[], evalDir?: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bun', [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: evalDir ? { ...process.env, GSTACK_DEV_HOME: evalDir } : process.env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('eval-list --limit validation', () => {
  test('rejects float (1.5) with exit 1', () => {
    const { exitCode, stderr } = run(['--limit', '1.5']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit');
  });

  test('rejects suffix (1abc) with exit 1', () => {
    const { exitCode, stderr } = run(['--limit', '1abc']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit');
  });

  test('rejects non-numeric (nope) with exit 1', () => {
    const { exitCode, stderr } = run(['--limit', 'nope']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit');
  });

  test('rejects zero with exit 1', () => {
    const { exitCode, stderr } = run(['--limit', '0']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit');
  });

  test('rejects negative with exit 1', () => {
    const { exitCode, stderr } = run(['--limit', '-3']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit');
  });

  test('accepts valid positive integer without error', () => {
    const { exitCode, stderr } = run(['--limit', '5']);
    // May exit 0 (no eval dir) or print "No eval runs yet" — must NOT exit 1
    expect(exitCode).not.toBe(1);
    expect(stderr).not.toContain('--limit must');
  });
});
