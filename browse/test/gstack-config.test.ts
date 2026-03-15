/**
 * Tests for bin/gstack-config bash script.
 *
 * Uses Bun.spawnSync to invoke the script with temp dirs and
 * GSTACK_STATE_DIR env override for full isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(import.meta.dir, '..', '..', 'bin', 'gstack-config');

let stateDir: string;

function run(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: {
      ...process.env,
      GSTACK_STATE_DIR: stateDir,
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'gstack-config-test-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('gstack-config', () => {
  // ─── get ──────────────────────────────────────────────────
  test('get on missing file returns empty, exit 0', () => {
    const { exitCode, stdout } = run(['get', 'auto_upgrade']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('get existing key returns value', () => {
    writeFileSync(join(stateDir, 'config.yaml'), 'auto_upgrade: true\n');
    const { exitCode, stdout } = run(['get', 'auto_upgrade']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('true');
  });

  test('get missing key returns empty', () => {
    writeFileSync(join(stateDir, 'config.yaml'), 'auto_upgrade: true\n');
    const { exitCode, stdout } = run(['get', 'nonexistent']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('get returns last value when key appears multiple times', () => {
    writeFileSync(join(stateDir, 'config.yaml'), 'foo: bar\nfoo: baz\n');
    const { exitCode, stdout } = run(['get', 'foo']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('baz');
  });

  // ─── set ──────────────────────────────────────────────────
  test('set creates file and writes key on missing file', () => {
    const { exitCode } = run(['set', 'auto_upgrade', 'true']);
    expect(exitCode).toBe(0);
    const content = readFileSync(join(stateDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('auto_upgrade: true');
  });

  test('set appends new key to existing file', () => {
    writeFileSync(join(stateDir, 'config.yaml'), 'foo: bar\n');
    const { exitCode } = run(['set', 'auto_upgrade', 'true']);
    expect(exitCode).toBe(0);
    const content = readFileSync(join(stateDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('foo: bar');
    expect(content).toContain('auto_upgrade: true');
  });

  test('set replaces existing key in-place', () => {
    writeFileSync(join(stateDir, 'config.yaml'), 'auto_upgrade: false\n');
    const { exitCode } = run(['set', 'auto_upgrade', 'true']);
    expect(exitCode).toBe(0);
    const content = readFileSync(join(stateDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('auto_upgrade: true');
    expect(content).not.toContain('auto_upgrade: false');
  });

  test('set creates state dir if missing', () => {
    const nestedDir = join(stateDir, 'nested', 'dir');
    const { exitCode } = run(['set', 'foo', 'bar'], { GSTACK_STATE_DIR: nestedDir });
    expect(exitCode).toBe(0);
    expect(existsSync(join(nestedDir, 'config.yaml'))).toBe(true);
  });

  // ─── list ─────────────────────────────────────────────────
  test('list shows all keys', () => {
    writeFileSync(join(stateDir, 'config.yaml'), 'auto_upgrade: true\nupdate_check: false\n');
    const { exitCode, stdout } = run(['list']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('auto_upgrade: true');
    expect(stdout).toContain('update_check: false');
  });

  test('list on missing file returns empty, exit 0', () => {
    const { exitCode, stdout } = run(['list']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── usage ────────────────────────────────────────────────
  test('no args shows usage and exits 1', () => {
    const { exitCode, stdout } = run([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('Usage');
  });
});
