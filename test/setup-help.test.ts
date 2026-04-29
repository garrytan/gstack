import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');

describe('setup: help output', () => {
  test('`./setup --help` exits cleanly with usage text', () => {
    const result = spawnSync('/bin/bash', [SETUP_SCRIPT, '--help'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: ./setup [options]');
    expect(result.stdout).toContain('--host <name>');
    expect(result.stdout).toContain('--team');
    expect(result.stdout).toContain('--no-team');
    expect(result.stdout).toContain('-h, --help');
  });

  test('help works even when bun is not on PATH', () => {
    const result = spawnSync('/bin/bash', [SETUP_SCRIPT, '--help'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: ./setup [options]');
    expect(result.stdout).not.toContain('bun is required');
  });

  test('`./setup -h` is supported as a short alias', () => {
    const result = spawnSync('/bin/bash', [SETUP_SCRIPT, '-h'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ./setup [options]');
  });
});
