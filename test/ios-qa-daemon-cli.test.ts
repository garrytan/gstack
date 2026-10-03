import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const DAEMON_BIN = join(ROOT, 'bin/gstack-ios-qa-daemon');

describe('gstack-ios-qa-daemon CLI', () => {
  test('--help prints usage and exits without starting the daemon', () => {
    const result = spawnSync('bash', [DAEMON_BIN, '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 2_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('gstack-ios-qa-daemon');
    expect(result.stdout).toContain('--tailnet');
    expect(result.stdout).toContain('GSTACK_IOS_DAEMON_PORT');
    expect(result.stdout).toContain('/healthz');
    expect(result.stderr).toBe('');
  });
});
