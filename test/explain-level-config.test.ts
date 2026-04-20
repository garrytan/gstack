/**
 * gstack-config explain_level round-trip + validation tests.
 *
 * Coverage:
 * - `set explain_level default` persists, `get` returns "default"
 * - `set explain_level terse` persists, `get` returns "terse"
 * - `set explain_level garbage` warns + writes "default"
 * - `get explain_level` with unset key returns empty (preamble bash defaults)
 * - Annotated config header documents explain_level
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_CONFIG = path.join(ROOT, 'bin', 'gstack-config');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cfg-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(BIN_CONFIG, args, {
    env: { ...process.env, GSTACK_STATE_DIR: tmpHome },
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return {
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status ?? -1,
  };
}

describe('gstack-config explain_level', () => {
  test('set + get default round-trip', () => {
    expect(run('set', 'explain_level', 'default').status).toBe(0);
    expect(run('get', 'explain_level').stdout).toBe('default');
  });

  test('set + get terse round-trip', () => {
    expect(run('set', 'explain_level', 'terse').status).toBe(0);
    expect(run('get', 'explain_level').stdout).toBe('terse');
  });

  test('unknown value warns and defaults to default', () => {
    const result = run('set', 'explain_level', 'garbage');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not recognized');
    expect(result.stderr).toContain('default, terse');
    expect(run('get', 'explain_level').stdout).toBe('default');
  });

  test('get with unset explain_level returns empty (preamble default takes over)', () => {
    // No prior set → no config file → empty output
    expect(run('get', 'explain_level').stdout).toBe('');
  });

  test('config header documents explain_level', () => {
    // Trigger file creation with any set
    run('set', 'explain_level', 'default');
    const cfg = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8');
    expect(cfg).toContain('explain_level');
    expect(cfg).toContain('default');
    expect(cfg).toContain('terse');
  });

  test('set terse, then set garbage restores default', () => {
    run('set', 'explain_level', 'terse');
    expect(run('get', 'explain_level').stdout).toBe('terse');
    const garbage = run('set', 'explain_level', 'nonsense');
    expect(garbage.stderr).toContain('not recognized');
    expect(run('get', 'explain_level').stdout).toBe('default');
  });
});
