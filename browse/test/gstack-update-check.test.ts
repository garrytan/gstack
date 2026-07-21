/** Tests for the retired passive updater and its explicit compatibility check. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'bin', 'gstack-update-check');

let gstackDir: string;
let stateDir: string;

function run(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: {
      ...process.env,
      GSTACK_HOME: '',
      GSTACK_DIR: gstackDir,
      GSTACK_STATE_DIR: stateDir,
      GSTACK_REMOTE_URL: `file://${join(gstackDir, 'REMOTE_VERSION')}`,
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
  gstackDir = mkdtempSync(join(tmpdir(), 'gstack-upd-test-'));
  stateDir = mkdtempSync(join(tmpdir(), 'gstack-state-test-'));
  const binDir = join(gstackDir, 'bin');
  mkdirSync(binDir);
  symlinkSync(join(ROOT, 'bin', 'gstack-config'), join(binDir, 'gstack-config'));
});

afterEach(() => {
  rmSync(gstackDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('gstack-update-check compatibility boundary', () => {
  test('passive invocation is a no-op even when an update and legacy state exist', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '2.0.0\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 1.0.0 2.0.0');
    writeFileSync(join(stateDir, 'update-snoozed'), '2.0.0 3 1');

    expect(run()).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf8')).toContain('UPGRADE_AVAILABLE');
    expect(existsSync(join(stateDir, 'update-snoozed'))).toBe(true);
  });

  test('passive invocation performs no network or state setup', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.0.0\n');
    const missingStateDir = join(stateDir, 'not-created');
    const result = run([], {
      GSTACK_STATE_DIR: missingStateDir,
      GSTACK_REMOTE_URL: 'https://127.0.0.1:1/must-not-be-requested',
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(existsSync(missingStateDir)).toBe(false);
  });

  test('--force reports and caches a newer valid version', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.9.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.10.0.0\n');

    expect(run(['--force']).stdout).toBe('UPGRADE_AVAILABLE 1.9.0.0 1.10.0.0');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf8').trim())
      .toBe('UPGRADE_AVAILABLE 1.9.0.0 1.10.0.0');
  });

  test('--force never offers a downgrade', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.10.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.9.0.0\n');

    expect(run(['--force']).stdout).toBe('');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf8').trim())
      .toBe('UP_TO_DATE 1.10.0.0');
  });

  test('--force treats malformed or unavailable responses as non-updates', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '<html>not a version</html>\n');

    expect(run(['--force']).stdout).toBe('');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf8').trim())
      .toBe('UP_TO_DATE 1.0.0');
  });

  test('--force clears obsolete snooze state and consumes the upgrade marker', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.0.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.9.0\n');
    writeFileSync(join(stateDir, 'update-snoozed'), '1.0.0 3 9999999999');

    expect(run(['--force']).stdout).toBe('JUST_UPGRADED 0.9.0 1.0.0');
    expect(existsSync(join(stateDir, 'just-upgraded-from'))).toBe(false);
    expect(existsSync(join(stateDir, 'update-snoozed'))).toBe(false);
  });

  test('--force with no local version exits cleanly without creating a cache', () => {
    expect(run(['--force'])).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(existsSync(join(stateDir, 'last-update-check'))).toBe(false);
  });
});
